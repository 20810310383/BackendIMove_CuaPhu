const crypto = require('crypto');

function getKey() {
  const raw = String(process.env.KYC_DATA_KEY || '').trim();
  if (!raw) {
    throw new Error('KYC_DATA_KEY chưa được cấu hình trong .env.');
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function encryptText(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptText(payload) {
  if (!payload) return null;
  const key = getKey();
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const encrypted = Buffer.from(payload.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function last4(value) {
  const text = String(value || '').replace(/\s+/g, '');
  return text ? text.slice(-4) : null;
}

function maskLast4(value) {
  const suffix = String(value || '').trim();
  return suffix ? `******${suffix}` : null;
}

module.exports = { encryptText, decryptText, last4, maskLast4 };