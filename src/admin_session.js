const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

const ADMIN_WEB_TOKEN_TYPE = 'ADMIN_WEB';

function jwtSecret() {
  const secret = String(process.env.JWT_ACCESS_SECRET || '').trim();
  if (secret.length < 32) {
    throw new Error('JWT_ACCESS_SECRET chưa được cấu hình an toàn.');
  }
  return secret;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function sessionHours() {
  return Math.max(1, Math.min(12, Number(process.env.ADMIN_AUTH_SESSION_HOURS || 8)));
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function authError(message, code = 'INVALID_TOKEN') {
  const error = new Error(message);
  error.status = 401;
  error.code = code;
  return error;
}

function safeObjectId(value) {
  try {
    return new ObjectId(String(value));
  } catch (_) {
    return null;
  }
}

async function ensureAdminSessionIndexes(db) {
  await Promise.all([
    db.collection('admin_sessions').createIndex({ tokenHash: 1 }, { unique: true, name: 'uq_admin_sessions_token_hash' }),
    db.collection('admin_sessions').createIndex({ adminUserId: 1, revokedAt: 1 }, { name: 'idx_admin_sessions_user_active' }),
    db.collection('admin_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_admin_sessions' }),
  ]).catch((error) => {
    console.warn('[ADMIN SESSION INDEX]', error.message);
  });
}

async function issueAdminSession({ db, user, req }) {
  const createdAt = new Date();
  const hours = sessionHours();
  const expiresAt = new Date(createdAt.getTime() + hours * 60 * 60 * 1000);
  const sessionId = new ObjectId();
  const accessToken = jwt.sign(
    {
      typ: ADMIN_WEB_TOKEN_TYPE,
      sid: String(sessionId),
    },
    jwtSecret(),
    {
      subject: String(user._id),
      expiresIn: `${hours}h`,
    },
  );

  await db.collection('admin_sessions').insertOne({
    _id: sessionId,
    adminUserId: user._id,
    tokenHash: tokenHash(accessToken),
    ip: req.ip || null,
    userAgent: String(req.headers['user-agent'] || ''),
    createdAt,
    lastSeenAt: createdAt,
    expiresAt,
    revokedAt: null,
    revokeReason: null,
  });

  return {
    accessToken,
    expiresAt,
    expiresInSeconds: hours * 60 * 60,
  };
}

async function verifyAdminSession({ db, token }) {
  if (!token) throw authError('Thiếu Access Token quản trị.', 'TOKEN_MISSING');

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret());
  } catch (error) {
    if (error?.name === 'TokenExpiredError') {
      throw authError('Phiên quản trị đã hết hạn.', 'TOKEN_EXPIRED');
    }
    throw authError('Access Token quản trị không hợp lệ.', 'INVALID_TOKEN');
  }

  const userId = safeObjectId(payload?.sub || payload?.userId);
  const sessionId = safeObjectId(payload?.sid);
  if (payload?.typ !== ADMIN_WEB_TOKEN_TYPE || !userId || !sessionId) {
    throw authError('Access Token quản trị không hợp lệ.', 'INVALID_TOKEN');
  }

  const session = await db.collection('admin_sessions').findOne({
    _id: sessionId,
    adminUserId: userId,
    tokenHash: tokenHash(token),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!session) {
    throw authError('Phiên quản trị đã bị thu hồi hoặc không còn hiệu lực.', 'SESSION_REVOKED');
  }

  return { payload, session, userId };
}

async function revokeAdminSession({ db, sessionId, reason = 'LOGOUT' }) {
  const id = safeObjectId(sessionId);
  if (!id) return false;
  const now = new Date();
  const result = await db.collection('admin_sessions').updateOne(
    { _id: id, revokedAt: null },
    { $set: { revokedAt: now, revokeReason: reason, updatedAt: now } },
  );
  return result.modifiedCount > 0;
}

async function revokeAdminSessionsForUser({ db, userId, reason }) {
  const id = safeObjectId(userId);
  if (!id) return 0;
  const now = new Date();
  const result = await db.collection('admin_sessions').updateMany(
    { adminUserId: id, revokedAt: null },
    { $set: { revokedAt: now, revokeReason: reason, updatedAt: now } },
  );
  return result.modifiedCount;
}

function createAdminSessionMiddleware({ getDb }) {
  return async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) return next();

    const decoded = jwt.decode(token);
    if (decoded?.typ !== ADMIN_WEB_TOKEN_TYPE) return next();

    try {
      const db = getDb();
      if (!db) return res.status(503).json({ message: 'Database chưa sẵn sàng.' });
      req.adminSession = await verifyAdminSession({ db, token });
      return next();
    } catch (error) {
      return res.status(error.status || 401).json({
        code: error.code || 'INVALID_TOKEN',
        message: error.message || 'Phiên quản trị không hợp lệ.',
      });
    }
  };
}

module.exports = {
  bearerToken,
  createAdminSessionMiddleware,
  ensureAdminSessionIndexes,
  issueAdminSession,
  revokeAdminSession,
  revokeAdminSessionsForUser,
  verifyAdminSession,
};
