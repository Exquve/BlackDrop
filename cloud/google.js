const { google } = require('googleapis');
const { encryptText, decryptText } = require('./crypto');

const APP_FOLDER = 'blackdrop';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
];

function createOAuthClient(config) {
    return new google.auth.OAuth2(
        decryptText(config.clientIdEncrypted),
        decryptText(config.clientSecretEncrypted),
        config.redirectUri
    );
}

function escapeDriveQuery(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function getAuthedClient(account, googleConfig, persistAccount) {
    if (!account.accessTokenEncrypted || !account.refreshTokenEncrypted) {
        throw new Error('Google account tokens are missing.');
    }
    if (!googleConfig) throw new Error('Google OAuth is not configured.');

    const client = createOAuthClient(googleConfig);
    client.setCredentials({
        access_token: decryptText(account.accessTokenEncrypted),
        refresh_token: decryptText(account.refreshTokenEncrypted),
        expiry_date: account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : undefined,
    });

    const expiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
    if (expiresAt < Date.now() + 60_000) {
        const result = await client.refreshAccessToken();
        const credentials = result.credentials;
        if (credentials.access_token) {
            account.accessTokenEncrypted = encryptText(credentials.access_token);
            account.tokenExpiresAt = new Date(credentials.expiry_date || Date.now() + 3600_000).toISOString();
            if (typeof persistAccount === 'function') persistAccount();
            client.setCredentials(credentials);
        }
    }

    return client;
}

async function syncGoogleQuota(account, googleConfig, persistAccount) {
    const auth = await getAuthedClient(account, googleConfig, persistAccount);
    const drive = google.drive({ version: 'v3', auth });
    const about = await drive.about.get({ fields: 'storageQuota,user' });
    const quota = about.data.storageQuota || {};
    const total = quota.limit != null ? Number(quota.limit) : null;
    const used = quota.usage != null ? Number(quota.usage) : 0;
    return {
        totalBytes: total,
        usedBytes: used,
        availableBytes: total == null ? null : total - used,
        trashBytes: quota.usageInDriveTrash != null ? Number(quota.usageInDriveTrash) : null,
        lastSyncedAt: new Date().toISOString(),
    };
}

async function ensureAppFolder(account, googleConfig, persistAccount) {
    const auth = await getAuthedClient(account, googleConfig, persistAccount);
    const drive = google.drive({ version: 'v3', auth });
    const q = `name = '${escapeDriveQuery(APP_FOLDER)}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`;
    const existing = await drive.files.list({ q, spaces: 'drive', fields: 'files(id,name)', pageSize: 1 });
    let folderId = existing.data.files?.[0]?.id;
    if (!folderId) {
        const created = await drive.files.create({
            requestBody: { name: APP_FOLDER, mimeType: FOLDER_MIME, parents: ['root'] },
            fields: 'id',
        });
        folderId = created.data.id;
    }
    if (!folderId) throw new Error('Failed to create Google Drive app folder.');
    return folderId;
}

async function uploadToDrive(account, googleConfig, persistAccount, { fileName, mimeType, body, parentId }) {
    const auth = await getAuthedClient(account, googleConfig, persistAccount);
    const drive = google.drive({ version: 'v3', auth });
    const uploaded = await drive.files.create({
        requestBody: { name: fileName, parents: [parentId] },
        media: { mimeType, body },
        fields: 'id,name,mimeType,size',
    });
    return {
        id: uploaded.data.id,
        name: uploaded.data.name || fileName,
        mimeType: uploaded.data.mimeType || mimeType,
        sizeBytes: Number(uploaded.data.size || 0),
    };
}

async function deleteDriveFile(account, googleConfig, persistAccount, providerFileId) {
    const auth = await getAuthedClient(account, googleConfig, persistAccount);
    const drive = google.drive({ version: 'v3', auth });
    await drive.files.delete({ fileId: providerFileId });
}

async function renameDriveFile(account, googleConfig, persistAccount, providerFileId, name) {
    const auth = await getAuthedClient(account, googleConfig, persistAccount);
    const drive = google.drive({ version: 'v3', auth });
    const updated = await drive.files.update({
        fileId: providerFileId,
        requestBody: { name },
        fields: 'id,name',
    });
    return updated.data;
}

async function createDriveFolder(account, googleConfig, persistAccount, name, parentId) {
    const auth = await getAuthedClient(account, googleConfig, persistAccount);
    const drive = google.drive({ version: 'v3', auth });
    const created = await drive.files.create({
        requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
        fields: 'id,name',
    });
    return created.data;
}

async function getDriveDownloadStream(account, googleConfig, persistAccount, providerFileId) {
    const auth = await getAuthedClient(account, googleConfig, persistAccount);
    const drive = google.drive({ version: 'v3', auth });
    const response = await drive.files.get(
        { fileId: providerFileId, alt: 'media' },
        { responseType: 'stream' }
    );
    return response.data;
}

async function syncAppFolderFiles(account, googleConfig, persistAccount, folders, cloudFiles, username) {
    const auth = await getAuthedClient(account, googleConfig, persistAccount);
    const drive = google.drive({ version: 'v3', auth });
    const appFolderId = await ensureAppFolder(account, googleConfig, persistAccount);

    const accountFolders = folders.filter(f => f.accountId === account.id && !f.deletedAt);
    const parentIds = [appFolderId, ...accountFolders.map(f => f.providerFolderId).filter(Boolean)];
    const parentsQuery = parentIds.map(id => `'${id}' in parents`).join(' or ');
    const q = `(${parentsQuery}) and mimeType != '${FOLDER_MIME}' and trashed = false`;

    const driveFiles = [];
    let pageToken;
    do {
        const response = await drive.files.list({
            q,
            spaces: 'drive',
            fields: 'nextPageToken,files(id,name,mimeType,size,parents)',
            pageSize: 1000,
            pageToken,
        });
        for (const file of response.data.files || []) {
            if (!file.id || !file.name || !file.mimeType) continue;
            driveFiles.push({
                id: file.id,
                name: file.name,
                mimeType: file.mimeType,
                sizeBytes: Number(file.size || 0),
                parentId: file.parents?.[0] || appFolderId,
            });
        }
        pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);

    const folderIdMap = new Map(accountFolders.map(f => [f.providerFolderId, f.id]));
    const existing = cloudFiles.filter(f => f.accountId === account.id && f.provider === 'google_drive');
    const byProvider = new Map(existing.map(f => [f.providerFileId, f]));
    const driveIds = new Set(driveFiles.map(f => f.id));
    let created = 0, updated = 0, deleted = 0;

    for (const df of driveFiles) {
        const folderId = df.parentId === appFolderId ? null : (folderIdMap.get(df.parentId) || null);
        const ex = byProvider.get(df.id);
        if (!ex) {
            cloudFiles.push({
                id: cryptoRandom(),
                username,
                accountId: account.id,
                folderId,
                provider: 'google_drive',
                providerFileId: df.id,
                name: df.name,
                mimeType: df.mimeType,
                sizeBytes: df.sizeBytes,
                status: 'active',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                deletedAt: null,
            });
            created++;
            continue;
        }
        if (ex.name !== df.name || ex.mimeType !== df.mimeType || ex.sizeBytes !== df.sizeBytes
            || ex.status !== 'active' || ex.folderId !== folderId) {
            ex.name = df.name;
            ex.mimeType = df.mimeType;
            ex.sizeBytes = df.sizeBytes;
            ex.status = 'active';
            ex.folderId = folderId;
            ex.deletedAt = null;
            ex.updatedAt = new Date().toISOString();
            updated++;
        }
    }

    for (const ex of existing) {
        if (ex.status === 'active' && !driveIds.has(ex.providerFileId)) {
            ex.status = 'deleted';
            ex.deletedAt = new Date().toISOString();
            deleted++;
        }
    }

    return { accountId: account.id, created, updated, deleted, appFolderId };
}

function cryptoRandom() {
    return require('crypto').randomUUID();
}

module.exports = {
    SCOPES,
    APP_FOLDER,
    createOAuthClient,
    getAuthedClient,
    syncGoogleQuota,
    ensureAppFolder,
    uploadToDrive,
    deleteDriveFile,
    renameDriveFile,
    createDriveFolder,
    getDriveDownloadStream,
    syncAppFolderFiles,
    encryptText,
    decryptText,
};
