const { S3Client, HeadBucketCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { decryptText } = require('./crypto');

function createS3Client(config) {
    return new S3Client({
        region: config.region || 'auto',
        endpoint: config.endpoint || undefined,
        forcePathStyle: !!config.forcePathStyle || !!config.endpoint,
        credentials: {
            accessKeyId: decryptText(config.accessKeyIdEncrypted),
            secretAccessKey: decryptText(config.secretAccessKeyEncrypted),
        },
    });
}

function safeFileName(name) {
    return String(name).replace(/[\\/]+/g, '-').replace(/[\u0000-\u001f\u007f]+/g, '').slice(0, 180) || 'file';
}

function buildS3ObjectKey(config, username, fileId, fileName) {
    const prefix = String(config.prefix || 'blackdrop').replace(/^\/+|\/+$/g, '');
    return `${prefix}/${username}/${fileId}/${safeFileName(fileName)}`;
}

async function testS3Connection(config) {
    const client = createS3Client(config);
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
}

async function uploadS3Object(config, key, body, mimeType) {
    const client = createS3Client(config);
    await new Upload({
        client,
        params: {
            Bucket: config.bucket,
            Key: key,
            Body: body,
            ContentType: mimeType,
        },
    }).done();
}

async function deleteS3Object(config, key) {
    const client = createS3Client(config);
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}

async function syncS3Quota(config) {
    const client = createS3Client(config);
    let usedBytes = 0;
    let continuationToken;
    do {
        const response = await client.send(new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: (config.prefix || 'blackdrop').replace(/^\/+|\/+$/g, '') + '/',
            ContinuationToken: continuationToken,
        }));
        for (const object of response.Contents || []) usedBytes += object.Size || 0;
        continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    const total = config.quotaBytes != null ? Number(config.quotaBytes) : null;
    return {
        totalBytes: total,
        usedBytes,
        availableBytes: total == null ? null : total - usedBytes,
        trashBytes: null,
        lastSyncedAt: new Date().toISOString(),
    };
}

async function streamS3File(config, key, res, { disposition = 'attachment', fileName, mimeType } = {}) {
    const client = createS3Client(config);
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    res.status(200);
    res.setHeader('Content-Type', response.ContentType || mimeType || 'application/octet-stream');
    if (disposition) {
        const safe = String(fileName || 'file').replace(/"/g, '');
        res.setHeader('Content-Disposition', `${disposition}; filename="${safe}"`);
    }
    if (response.ContentLength != null) res.setHeader('Content-Length', String(response.ContentLength));
    const body = response.Body;
    if (!body) return res.end();
    return body.pipe(res);
}

module.exports = {
    createS3Client,
    buildS3ObjectKey,
    testS3Connection,
    uploadS3Object,
    deleteS3Object,
    syncS3Quota,
    streamS3File,
};
