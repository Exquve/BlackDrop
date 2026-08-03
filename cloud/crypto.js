const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY
    || process.env.JWT_SECRET
    || 'blackdrop-cloud-encryption-key-32b';

const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();

function encryptText(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptText(value) {
    const [ivRaw, tagRaw, encryptedRaw] = String(value).split(':');
    if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error('Invalid encrypted payload');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(encryptedRaw, 'base64')),
        decipher.final()
    ]).toString('utf8');
}

function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { encryptText, decryptText, randomToken, hashToken };
