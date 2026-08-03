const express = require('express');
const Busboy = require('busboy');
const { Readable } = require('stream');
const { createCloudStore } = require('./store');
const { encryptText, decryptText, randomToken, hashToken } = require('./crypto');
const googleSvc = require('./google');
const s3Svc = require('./s3');
const { selectAccount, normalizePriorityIds } = require('./routing');

function createCloudRouter({ dataDir, authenticateToken, getFrontendOrigin, maxUploadBytes = 5 * 1024 * 1024 * 1024 }) {
    const router = express.Router();
    const { uuid, state, persist } = createCloudStore(dataDir);

    function usernameOf(req) {
        return req.user?.username || 'guest';
    }

    function publicAccount(account) {
        const quota = state.quotas[account.id] || null;
        return {
            id: account.id,
            provider: account.provider,
            email: account.email,
            displayName: account.displayName,
            status: account.status,
            lastError: account.lastError || null,
            createdAt: account.createdAt,
            quota,
        };
    }

    async function refreshQuota(account) {
        try {
            let quota;
            if (account.provider === 'google_drive') {
                if (!state.googleConfig) throw new Error('Google OAuth not configured');
                quota = await googleSvc.syncGoogleQuota(account, state.googleConfig, () => persist.accounts());
            } else if (account.provider === 's3') {
                const config = state.s3Configs[account.id];
                if (!config) throw new Error('S3 config missing');
                quota = await s3Svc.syncS3Quota(config);
            } else {
                return null;
            }
            state.quotas[account.id] = quota;
            persist.quotas();
            account.lastError = null;
            persist.accounts();
            return quota;
        } catch (err) {
            account.lastError = err.message || 'Quota sync failed';
            persist.accounts();
            throw err;
        }
    }

    function accountsForUser(username) {
        return state.accounts.filter(a => a.username === username && a.status === 'connected');
    }

    function accountsWithQuota(username) {
        return accountsForUser(username).map(a => ({
            ...a,
            availableBytes: state.quotas[a.id]?.availableBytes ?? null,
            usedBytes: state.quotas[a.id]?.usedBytes ?? 0,
            totalBytes: state.quotas[a.id]?.totalBytes ?? null,
        }));
    }

    // -------------------------------------------------------------------------
    // Status / summary
    // -------------------------------------------------------------------------
    router.get('/status', authenticateToken, (req, res) => {
        const username = usernameOf(req);
        const accounts = accountsForUser(username).map(publicAccount);
        const files = state.cloudFiles.filter(f => f.username === username && f.status === 'active');
        const folders = state.folders.filter(f => f.username === username && !f.deletedAt);
        const totalUsed = accounts.reduce((sum, a) => sum + (a.quota?.usedBytes || 0), 0);
        const totalAvail = accounts.reduce((sum, a) => {
            if (a.quota?.totalBytes == null) return sum;
            return sum + (a.quota.totalBytes || 0);
        }, 0);
        res.json({
            googleConfigured: !!state.googleConfig,
            accountCount: accounts.length,
            fileCount: files.length,
            folderCount: folders.length,
            routing: state.routing,
            storage: { used: totalUsed, total: totalAvail || null },
            accounts,
        });
    });

    router.get('/summary', authenticateToken, async (req, res) => {
        const username = usernameOf(req);
        const accounts = accountsForUser(username);
        await Promise.allSettled(accounts.map(a => refreshQuota(a)));
        res.json({
            accounts: accountsForUser(username).map(publicAccount),
            routing: state.routing,
        });
    });

    // -------------------------------------------------------------------------
    // Google OAuth config (admin / superadmin)
    // -------------------------------------------------------------------------
    router.get('/google-config', authenticateToken, (req, res) => {
        if (!state.googleConfig) return res.json({ configured: false });
        res.json({
            configured: true,
            clientId: decryptText(state.googleConfig.clientIdEncrypted).slice(0, 12) + '…',
            redirectUri: state.googleConfig.redirectUri,
            updatedAt: state.googleConfig.updatedAt,
        });
    });

    router.put('/google-config', authenticateToken, (req, res) => {
        if (req.user?.role !== 'superadmin' && req.user?.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const { clientId, clientSecret, redirectUri } = req.body || {};
        if (!clientId || !clientSecret || !redirectUri) {
            return res.status(400).json({ error: 'clientId, clientSecret, and redirectUri are required' });
        }
        state.googleConfig = {
            clientIdEncrypted: encryptText(clientId),
            clientSecretEncrypted: encryptText(clientSecret),
            redirectUri,
            updatedAt: new Date().toISOString(),
        };
        persist.googleConfig();
        res.json({ configured: true, redirectUri });
    });

    // -------------------------------------------------------------------------
    // Connect Google Drive
    // -------------------------------------------------------------------------
    router.get('/accounts/google/connect-url', authenticateToken, (req, res) => {
        if (!state.googleConfig) {
            return res.status(400).json({ error: 'Google OAuth is not configured. Set credentials in Cloud Settings.' });
        }
        const stateToken = randomToken(24);
        state.oauthStates[hashToken(stateToken)] = {
            username: usernameOf(req),
            flow: 'connect',
            expiresAt: Date.now() + 10 * 60 * 1000,
        };
        persist.oauthStates();

        const client = googleSvc.createOAuthClient(state.googleConfig);
        const url = client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: googleSvc.SCOPES,
            state: stateToken,
        });
        res.json({ url });
    });

    router.get('/accounts/google/callback', async (req, res) => {
        try {
            const { code, state: stateToken } = req.query;
            if (!code || !stateToken) return res.status(400).send('Missing code or state');
            const hashed = hashToken(stateToken);
            const oauth = state.oauthStates[hashed];
            if (!oauth || oauth.expiresAt < Date.now()) {
                return res.status(400).send('Invalid or expired OAuth state');
            }
            delete state.oauthStates[hashed];
            persist.oauthStates();

            if (!state.googleConfig) return res.status(400).send('Google OAuth not configured');
            const client = googleSvc.createOAuthClient(state.googleConfig);
            const { tokens } = await client.getToken(code);
            client.setCredentials(tokens);

            const oauth2 = require('googleapis').google.oauth2({ version: 'v2', auth: client });
            const me = await oauth2.userinfo.get();
            const email = me.data.email;
            const providerAccountId = me.data.id;

            let account = state.accounts.find(
                a => a.username === oauth.username && a.provider === 'google_drive' && a.providerAccountId === providerAccountId
            );

            if (!tokens.refresh_token && !account?.refreshTokenEncrypted) {
                return res.status(400).send('Google did not return a refresh token. Revoke app access and try again with consent.');
            }

            if (!account) {
                account = {
                    id: uuid(),
                    username: oauth.username,
                    provider: 'google_drive',
                    providerAccountId,
                    email,
                    displayName: me.data.name || email,
                    accessTokenEncrypted: encryptText(tokens.access_token),
                    refreshTokenEncrypted: encryptText(tokens.refresh_token),
                    tokenExpiresAt: new Date(tokens.expiry_date || Date.now() + 3600_000).toISOString(),
                    status: 'connected',
                    lastError: null,
                    createdAt: new Date().toISOString(),
                };
                state.accounts.push(account);
            } else {
                account.accessTokenEncrypted = encryptText(tokens.access_token);
                if (tokens.refresh_token) account.refreshTokenEncrypted = encryptText(tokens.refresh_token);
                account.tokenExpiresAt = new Date(tokens.expiry_date || Date.now() + 3600_000).toISOString();
                account.status = 'connected';
                account.lastError = null;
                account.email = email;
                account.displayName = me.data.name || email;
            }
            persist.accounts();

            await googleSvc.ensureAppFolder(account, state.googleConfig, () => persist.accounts());
            await refreshQuota(account).catch(() => null);

            const origin = getFrontendOrigin ? getFrontendOrigin(req) : '/';
            const dest = origin.startsWith('http') ? `${origin}?cloud=connected` : `/?cloud=connected`;
            res.redirect(dest);
        } catch (err) {
            console.error('[cloud] google callback error', err);
            res.status(500).send('Google connect failed: ' + (err.message || 'unknown'));
        }
    });

    // -------------------------------------------------------------------------
    // Accounts CRUD + S3 connect
    // -------------------------------------------------------------------------
    router.get('/accounts', authenticateToken, (req, res) => {
        res.json({ accounts: accountsForUser(usernameOf(req)).map(publicAccount) });
    });

    router.post('/accounts/:id/sync-quota', authenticateToken, async (req, res) => {
        const account = state.accounts.find(a => a.id === req.params.id && a.username === usernameOf(req));
        if (!account) return res.status(404).json({ error: 'Account not found' });
        try {
            const quota = await refreshQuota(account);
            res.json({ account: publicAccount(account), quota });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/accounts/:id', authenticateToken, (req, res) => {
        const idx = state.accounts.findIndex(a => a.id === req.params.id && a.username === usernameOf(req));
        if (idx < 0) return res.status(404).json({ error: 'Account not found' });
        const [removed] = state.accounts.splice(idx, 1);
        delete state.quotas[removed.id];
        delete state.s3Configs[removed.id];
        state.cloudFiles.forEach(f => {
            if (f.accountId === removed.id) {
                f.status = 'deleted';
                f.deletedAt = new Date().toISOString();
            }
        });
        persist.accounts();
        persist.quotas();
        persist.s3Configs();
        persist.cloudFiles();
        res.json({ message: 'Account disconnected' });
    });

    router.post('/accounts/s3', authenticateToken, async (req, res) => {
        const username = usernameOf(req);
        const {
            name, bucket, region, endpoint, accessKeyId, secretAccessKey,
            forcePathStyle, prefix, quotaBytes,
        } = req.body || {};

        if (!name || !bucket || !accessKeyId || !secretAccessKey) {
            return res.status(400).json({ error: 'name, bucket, accessKeyId, secretAccessKey are required' });
        }

        const config = {
            name,
            bucket,
            region: region || 'auto',
            endpoint: endpoint || null,
            accessKeyIdEncrypted: encryptText(accessKeyId),
            secretAccessKeyEncrypted: encryptText(secretAccessKey),
            forcePathStyle: !!forcePathStyle,
            prefix: prefix || 'blackdrop',
            quotaBytes: quotaBytes != null && quotaBytes !== '' ? Number(quotaBytes) : null,
            status: 'active',
        };

        try {
            await s3Svc.testS3Connection(config);
        } catch (err) {
            return res.status(400).json({ error: 'S3 connection failed: ' + (err.message || 'unknown') });
        }

        const account = {
            id: uuid(),
            username,
            provider: 's3',
            providerAccountId: `${bucket}:${endpoint || region || 'default'}`,
            email: name,
            displayName: name,
            status: 'connected',
            lastError: null,
            createdAt: new Date().toISOString(),
        };
        state.accounts.push(account);
        state.s3Configs[account.id] = config;
        persist.accounts();
        persist.s3Configs();

        try {
            state.quotas[account.id] = await s3Svc.syncS3Quota(config);
            persist.quotas();
        } catch (_) { /* ignore */ }

        res.json({ account: publicAccount(account) });
    });

    // -------------------------------------------------------------------------
    // Routing policy
    // -------------------------------------------------------------------------
    router.get('/routing-policy', authenticateToken, (req, res) => {
        res.json({
            policy: {
                mode: state.routing.mode || 'most_available',
                priorityAccountIds: normalizePriorityIds(state.routing.priorityAccountIds),
                roundRobinCursor: state.routing.roundRobinCursor || 0,
            },
        });
    });

    router.patch('/routing-policy', authenticateToken, (req, res) => {
        const { mode, priorityAccountIds } = req.body || {};
        if (!['most_available', 'round_robin', 'priority'].includes(mode)) {
            return res.status(400).json({ error: 'Invalid mode' });
        }
        const validIds = new Set(accountsForUser(usernameOf(req)).map(a => a.id));
        state.routing = {
            mode,
            priorityAccountIds: normalizePriorityIds(priorityAccountIds).filter(id => validIds.has(id)),
            roundRobinCursor: mode === 'round_robin' ? (state.routing.roundRobinCursor || 0) : 0,
        };
        persist.routing();
        res.json({ policy: state.routing });
    });

    // -------------------------------------------------------------------------
    // Virtual folders
    // -------------------------------------------------------------------------
    router.get('/folders', authenticateToken, (req, res) => {
        const username = usernameOf(req);
        const folders = state.folders
            .filter(f => f.username === username && !f.deletedAt)
            .map(f => ({
                id: f.id,
                name: f.name,
                parentId: f.parentId || null,
                accountId: f.accountId || null,
                createdAt: f.createdAt,
            }));
        res.json({ folders });
    });

    router.post('/folders', authenticateToken, async (req, res) => {
        const username = usernameOf(req);
        const { name, parentId, accountId } = req.body || {};
        if (!name || String(name).trim().length === 0) {
            return res.status(400).json({ error: 'Folder name required' });
        }

        let providerFolderId = null;
        let targetAccountId = accountId || null;

        if (parentId) {
            const parent = state.folders.find(f => f.id === parentId && f.username === username && !f.deletedAt);
            if (!parent) return res.status(404).json({ error: 'Parent folder not found' });
            targetAccountId = parent.accountId || targetAccountId;
        }

        if (targetAccountId) {
            const account = state.accounts.find(a => a.id === targetAccountId && a.username === username);
            if (account?.provider === 'google_drive' && state.googleConfig) {
                try {
                    let parentDriveId;
                    if (parentId) {
                        const parent = state.folders.find(f => f.id === parentId);
                        parentDriveId = parent?.providerFolderId;
                    }
                    if (!parentDriveId) {
                        parentDriveId = await googleSvc.ensureAppFolder(account, state.googleConfig, () => persist.accounts());
                    }
                    const created = await googleSvc.createDriveFolder(
                        account, state.googleConfig, () => persist.accounts(), String(name).trim(), parentDriveId
                    );
                    providerFolderId = created.id;
                } catch (err) {
                    return res.status(500).json({ error: 'Drive folder create failed: ' + err.message });
                }
            }
        }

        const folder = {
            id: uuid(),
            username,
            name: String(name).trim(),
            parentId: parentId || null,
            accountId: targetAccountId,
            providerFolderId,
            createdAt: new Date().toISOString(),
            deletedAt: null,
        };
        state.folders.push(folder);
        persist.folders();
        res.json({ folder });
    });

    router.delete('/folders/:id', authenticateToken, (req, res) => {
        const folder = state.folders.find(f => f.id === req.params.id && f.username === usernameOf(req));
        if (!folder) return res.status(404).json({ error: 'Folder not found' });
        folder.deletedAt = new Date().toISOString();
        // Soft-delete nested folders
        const toDelete = new Set([folder.id]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const f of state.folders) {
                if (!f.deletedAt && f.parentId && toDelete.has(f.parentId)) {
                    f.deletedAt = new Date().toISOString();
                    toDelete.add(f.id);
                    changed = true;
                }
            }
        }
        for (const file of state.cloudFiles) {
            if (file.folderId && toDelete.has(file.folderId) && file.status === 'active') {
                // Keep files but detach from folder
                file.folderId = null;
            }
        }
        persist.folders();
        persist.cloudFiles();
        res.json({ message: 'Folder deleted' });
    });

    // -------------------------------------------------------------------------
    // Files list / CRUD
    // -------------------------------------------------------------------------
    router.get('/files', authenticateToken, (req, res) => {
        const username = usernameOf(req);
        const { folderId, q } = req.query;
        let files = state.cloudFiles.filter(f => f.username === username && f.status === 'active');
        if (folderId === 'root' || folderId === '' || folderId === undefined) {
            if (folderId === 'root' || folderId === '') files = files.filter(f => !f.folderId);
        } else if (folderId) {
            files = files.filter(f => f.folderId === folderId);
        }
        if (q) {
            const needle = String(q).toLowerCase();
            files = files.filter(f => f.name.toLowerCase().includes(needle));
        }
        files.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json({
            files: files.map(f => ({
                id: f.id,
                name: f.name,
                mimeType: f.mimeType,
                sizeBytes: f.sizeBytes,
                provider: f.provider,
                accountId: f.accountId,
                folderId: f.folderId,
                createdAt: f.createdAt,
                updatedAt: f.updatedAt,
            })),
        });
    });

    router.patch('/files/:id', authenticateToken, async (req, res) => {
        const username = usernameOf(req);
        const file = state.cloudFiles.find(f => f.id === req.params.id && f.username === username && f.status === 'active');
        if (!file) return res.status(404).json({ error: 'File not found' });
        const { name, folderId } = req.body || {};
        if (name && name !== file.name) {
            const account = state.accounts.find(a => a.id === file.accountId);
            if (account?.provider === 'google_drive' && state.googleConfig) {
                try {
                    await googleSvc.renameDriveFile(account, state.googleConfig, () => persist.accounts(), file.providerFileId, name);
                } catch (err) {
                    return res.status(500).json({ error: err.message });
                }
            }
            file.name = name;
        }
        if (folderId !== undefined) {
            if (folderId === null) file.folderId = null;
            else {
                const folder = state.folders.find(f => f.id === folderId && f.username === username && !f.deletedAt);
                if (!folder) return res.status(404).json({ error: 'Folder not found' });
                file.folderId = folderId;
            }
        }
        file.updatedAt = new Date().toISOString();
        persist.cloudFiles();
        res.json({ file });
    });

    router.delete('/files/:id', authenticateToken, async (req, res) => {
        const username = usernameOf(req);
        const file = state.cloudFiles.find(f => f.id === req.params.id && f.username === username && f.status === 'active');
        if (!file) return res.status(404).json({ error: 'File not found' });
        const account = state.accounts.find(a => a.id === file.accountId);
        try {
            if (account?.provider === 'google_drive' && state.googleConfig) {
                await googleSvc.deleteDriveFile(account, state.googleConfig, () => persist.accounts(), file.providerFileId);
            } else if (account?.provider === 's3') {
                const config = state.s3Configs[account.id];
                if (config) await s3Svc.deleteS3Object(config, file.providerFileId);
            }
        } catch (err) {
            console.warn('[cloud] remote delete failed', err.message);
        }
        file.status = 'deleted';
        file.deletedAt = new Date().toISOString();
        persist.cloudFiles();
        res.json({ message: 'File deleted' });
    });

    router.get('/files/:id/download', authenticateToken, async (req, res) => {
        const username = usernameOf(req);
        const file = state.cloudFiles.find(f => f.id === req.params.id && f.username === username && f.status === 'active');
        if (!file) return res.status(404).json({ error: 'File not found' });
        const account = state.accounts.find(a => a.id === file.accountId);
        if (!account) return res.status(404).json({ error: 'Account missing' });
        try {
            if (account.provider === 'google_drive') {
                const stream = await googleSvc.getDriveDownloadStream(
                    account, state.googleConfig, () => persist.accounts(), file.providerFileId
                );
                res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
                res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/"/g, '')}"`);
                stream.pipe(res);
            } else if (account.provider === 's3') {
                const config = state.s3Configs[account.id];
                await s3Svc.streamS3File(config, file.providerFileId, res, {
                    disposition: 'attachment',
                    fileName: file.name,
                    mimeType: file.mimeType,
                });
            } else {
                res.status(400).json({ error: 'Unknown provider' });
            }
        } catch (err) {
            console.error('[cloud] download error', err);
            if (!res.headersSent) res.status(500).json({ error: err.message });
        }
    });

    router.get('/files/:id/view', authenticateToken, async (req, res) => {
        const username = usernameOf(req);
        const file = state.cloudFiles.find(f => f.id === req.params.id && f.username === username && f.status === 'active');
        if (!file) return res.status(404).json({ error: 'File not found' });
        const account = state.accounts.find(a => a.id === file.accountId);
        if (!account) return res.status(404).json({ error: 'Account missing' });
        try {
            if (account.provider === 'google_drive') {
                const stream = await googleSvc.getDriveDownloadStream(
                    account, state.googleConfig, () => persist.accounts(), file.providerFileId
                );
                res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
                res.setHeader('Content-Disposition', `inline; filename="${file.name.replace(/"/g, '')}"`);
                stream.pipe(res);
            } else if (account.provider === 's3') {
                const config = state.s3Configs[account.id];
                await s3Svc.streamS3File(config, file.providerFileId, res, {
                    disposition: 'inline',
                    fileName: file.name,
                    mimeType: file.mimeType,
                });
            } else {
                res.status(400).json({ error: 'Unknown provider' });
            }
        } catch (err) {
            if (!res.headersSent) res.status(500).json({ error: err.message });
        }
    });

    router.post('/files/sync-google', authenticateToken, async (req, res) => {
        const username = usernameOf(req);
        const googleAccounts = accountsForUser(username).filter(a => a.provider === 'google_drive');
        if (!state.googleConfig) return res.status(400).json({ error: 'Google OAuth not configured' });
        const results = [];
        for (const account of googleAccounts) {
            try {
                const result = await googleSvc.syncAppFolderFiles(
                    account, state.googleConfig, () => persist.accounts(),
                    state.folders, state.cloudFiles, username
                );
                await refreshQuota(account).catch(() => null);
                results.push(result);
            } catch (err) {
                results.push({ accountId: account.id, error: err.message });
            }
        }
        persist.cloudFiles();
        persist.folders();
        res.json({ results });
    });

    // -------------------------------------------------------------------------
    // Uploads (stream via multer-like busboy)
    // -------------------------------------------------------------------------
    async function handleCloudUpload(req, res) {
        const username = usernameOf(req);
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
            return res.status(400).json({ error: 'multipart/form-data required' });
        }

        const busboy = Busboy({ headers: req.headers, limits: { files: 25, fileSize: maxUploadBytes } });
        const fields = {};
        let responded = false;
        const completed = [];
        const failed = [];
        const pending = [];
        const reserved = new Map();

        const fail = (status, message) => {
            if (responded) return;
            responded = true;
            req.unpipe(busboy);
            req.resume();
            return res.status(status).json({ error: message });
        };

        busboy.on('field', (name, val) => { fields[name] = val; });

        busboy.on('file', (fieldName, fileStream, info) => {
            const task = (async () => {
                const fileName = fields.fileName || info.filename || 'file';
                const mimeType = fields.mimeType || info.mimeType || 'application/octet-stream';
                const sizeBytes = Number(fields.sizeBytes || 0);
                const folderId = fields.folderId || null;

                try {
                    if (!sizeBytes || sizeBytes <= 0) {
                        fileStream.resume();
                        failed.push({ fileName, error: 'sizeBytes must be sent before file' });
                        return;
                    }
                    if (sizeBytes > maxUploadBytes) {
                        fileStream.resume();
                        failed.push({ fileName, error: 'File too large' });
                        return;
                    }

                    // Refresh stale quotas
                    const accounts = accountsWithQuota(username);
                    const stale = accounts.filter(a => {
                        const q = state.quotas[a.id];
                        return !q?.lastSyncedAt || new Date(q.lastSyncedAt).getTime() < Date.now() - 5 * 60_000;
                    });
                    await Promise.allSettled(stale.map(a => refreshQuota(a)));

                    let targetAccountId = fields.accountId || null;
                    if (folderId) {
                        const folder = state.folders.find(f => f.id === folderId && f.username === username);
                        if (folder?.accountId) targetAccountId = folder.accountId;
                    }

                    const { account, routing } = selectAccount(
                        accountsWithQuota(username),
                        sizeBytes,
                        state.routing,
                        { targetAccountId, reservedBytesByAccount: reserved }
                    );
                    state.routing = routing;
                    persist.routing();

                    if (!account) {
                        fileStream.resume();
                        failed.push({ fileName, error: 'No connected storage account has enough space' });
                        return;
                    }
                    reserved.set(account.id, (reserved.get(account.id) || 0) + sizeBytes);

                    const chunks = [];
                    for await (const chunk of fileStream) chunks.push(chunk);
                    const buffer = Buffer.concat(chunks);
                    if (buffer.length !== sizeBytes) {
                        failed.push({ fileName, error: 'Size mismatch' });
                        return;
                    }

                    let providerFileId = '';
                    let uploadedName = fileName;
                    let uploadedMime = mimeType;
                    const fileId = uuid();

                    if (account.provider === 's3') {
                        const config = state.s3Configs[account.id];
                        providerFileId = s3Svc.buildS3ObjectKey(config, username, fileId, fileName);
                        await s3Svc.uploadS3Object(config, providerFileId, Readable.from(buffer), mimeType);
                        refreshQuota(account).catch(() => null);
                    } else {
                        if (!state.googleConfig) {
                            failed.push({ fileName, error: 'Google OAuth not configured' });
                            return;
                        }
                        let parentId = await googleSvc.ensureAppFolder(account, state.googleConfig, () => persist.accounts());
                        if (folderId) {
                            const folder = state.folders.find(f => f.id === folderId);
                            if (folder?.providerFolderId) parentId = folder.providerFolderId;
                        }
                        const uploaded = await googleSvc.uploadToDrive(
                            account, state.googleConfig, () => persist.accounts(),
                            { fileName, mimeType, body: Readable.from(buffer), parentId }
                        );
                        providerFileId = uploaded.id;
                        uploadedName = uploaded.name;
                        uploadedMime = uploaded.mimeType;
                        refreshQuota(account).catch(() => null);
                    }

                    const record = {
                        id: fileId,
                        username,
                        accountId: account.id,
                        folderId: folderId || null,
                        provider: account.provider,
                        providerFileId,
                        name: uploadedName,
                        mimeType: uploadedMime,
                        sizeBytes,
                        status: 'active',
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        deletedAt: null,
                    };
                    state.cloudFiles.push(record);
                    persist.cloudFiles();
                    completed.push({
                        id: record.id,
                        name: record.name,
                        mimeType: record.mimeType,
                        sizeBytes: record.sizeBytes,
                        provider: record.provider,
                        accountId: record.accountId,
                        folderId: record.folderId,
                    });
                } catch (err) {
                    console.error('[cloud] upload failed', err);
                    failed.push({ fileName, error: err.message || 'Upload failed' });
                }
            })();
            pending.push(task);
        });

        busboy.on('error', (err) => fail(500, err.message));
        busboy.on('finish', async () => {
            await Promise.all(pending);
            if (responded) return;
            responded = true;
            if (completed.length === 0 && failed.length > 0) {
                return res.status(400).json({ completed, failed });
            }
            res.json({ completed, failed });
        });

        req.pipe(busboy);
    }

    router.post('/uploads', authenticateToken, handleCloudUpload);

    // -------------------------------------------------------------------------
    // API keys + public upload
    // -------------------------------------------------------------------------
    router.get('/api-keys', authenticateToken, (req, res) => {
        const username = usernameOf(req);
        const keys = state.apiKeys
            .filter(k => k.username === username && k.status === 'active')
            .map(k => ({
                id: k.id,
                name: k.name,
                keyPrefix: k.keyPrefix,
                lastUsedAt: k.lastUsedAt,
                createdAt: k.createdAt,
                scopes: k.scopes,
            }));
        res.json({ keys });
    });

    router.post('/api-keys', authenticateToken, (req, res) => {
        const username = usernameOf(req);
        const name = (req.body?.name || 'Default').trim();
        const raw = `bd_${randomToken(24)}`;
        const key = {
            id: uuid(),
            username,
            name,
            keyPrefix: raw.slice(0, 10),
            keyHash: hashToken(raw),
            scopes: ['upload'],
            status: 'active',
            lastUsedAt: null,
            createdAt: new Date().toISOString(),
            revokedAt: null,
        };
        state.apiKeys.push(key);
        persist.apiKeys();
        res.json({
            key: {
                id: key.id,
                name: key.name,
                keyPrefix: key.keyPrefix,
                createdAt: key.createdAt,
                scopes: key.scopes,
            },
            secret: raw, // shown once
        });
    });

    router.delete('/api-keys/:id', authenticateToken, (req, res) => {
        const key = state.apiKeys.find(k => k.id === req.params.id && k.username === usernameOf(req));
        if (!key) return res.status(404).json({ error: 'Key not found' });
        key.status = 'revoked';
        key.revokedAt = new Date().toISOString();
        persist.apiKeys();
        res.json({ message: 'Key revoked' });
    });

    function apiKeyAuth(req, res, next) {
        const header = req.headers['authorization'] || '';
        const raw = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] || '');
        if (!raw) return res.status(401).json({ error: 'API key required' });
        const hashed = hashToken(raw);
        const key = state.apiKeys.find(k => k.keyHash === hashed && k.status === 'active');
        if (!key) return res.status(401).json({ error: 'Invalid API key' });
        key.lastUsedAt = new Date().toISOString();
        persist.apiKeys();
        req.user = { username: key.username, role: 'user', viaApiKey: true };
        next();
    }

    // Public external upload API (9drive-style)
    const publicRouter = express.Router();
    publicRouter.post('/uploads', apiKeyAuth, handleCloudUpload);

    return { router, publicRouter, state, persist };
}

module.exports = { createCloudRouter };
