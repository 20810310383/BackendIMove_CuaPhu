const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ADMIN_CONTEXT_TTL_MS = 30_000;
const ADMIN_CONTEXT_CACHE_MAX = 1_000;
const adminContextCache = new Map();
const pendingAdminContexts = new Map();

function jwtSecret() {
  const secret = String(process.env.JWT_ACCESS_SECRET || '').trim();
  if (secret.length < 32) throw new Error('JWT_ACCESS_SECRET chưa an toàn.');
  return secret;
}

function contextKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function cacheAdminContext(key, value) {
  const now = Date.now();
  for (const [cachedKey, cached] of adminContextCache) {
    if (cached.expiresAt <= now) adminContextCache.delete(cachedKey);
  }
  while (adminContextCache.size >= ADMIN_CONTEXT_CACHE_MAX) {
    const oldestKey = adminContextCache.keys().next().value;
    if (!oldestKey) break;
    adminContextCache.delete(oldestKey);
  }
  adminContextCache.set(key, { value, expiresAt: now + ADMIN_CONTEXT_TTL_MS });
}

function databaseUnavailable(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`.toLowerCase();
  return /mongo|database|server selection|topology|timed out|connection|network/.test(text);
}

async function loadAdminContext(db, userId, key) {
  const cached = adminContextCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const pending = pendingAdminContexts.get(key);
  if (pending) return pending;

  const request = (async () => {
    const user = await db.collection('users').findOne(
      { _id: userId, roles: 'ADMIN' },
      { maxTimeMS: 8_000 },
    );
    if (!user) return null;

    const codes = Array.isArray(user.adminRoleCodes)
      ? user.adminRoleCodes
      : (Array.isArray(user.roleCodes) ? user.roleCodes : []);
    const permissions = (!codes.length || codes.includes('SUPER_ADMIN'))
      ? ['*']
      : [...new Set((await db.collection('admin_roles')
        .find({ code: { $in: codes }, status: 'ACTIVE' }, { maxTimeMS: 8_000 })
        .toArray())
        .flatMap((role) => Array.isArray(role.permissions) ? role.permissions : []))];

    const value = { user, permissions };
    cacheAdminContext(key, value);
    return value;
  })();

  pendingAdminContexts.set(key, request);
  try {
    return await request;
  } finally {
    if (pendingAdminContexts.get(key) === request) pendingAdminContexts.delete(key);
  }
}

function createAdminGuard({ getDb }) {
  async function requireAdmin(req, res, next) {
    try {
      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'Thiếu Access Token quản trị.' });
      const token = header.slice(7).trim();
      const payload = jwt.verify(token, jwtSecret());
      const { ObjectId } = require('mongodb');
      let id;
      try { id = new ObjectId(String(payload.sub || payload.userId)); }
      catch (_) { return res.status(401).json({ message: 'Access Token không hợp lệ.' }); }

      const db = getDb();
      if (!db) return res.status(503).json({ code: 'DATABASE_UNAVAILABLE', message: 'MongoDB chưa sẵn sàng. Vui lòng thử lại.' });
      const context = await loadAdminContext(db, id, contextKey(token));
      if (!context) return res.status(403).json({ message: 'Không có quyền ADMIN.' });
      req.admin = context.user;
      req.adminPermissions = context.permissions;
      return next();
    } catch (error) {
      if (databaseUnavailable(error)) {
        return res.status(503).json({ code: 'DATABASE_UNAVAILABLE', message: 'MongoDB đang tạm thời không phản hồi. Vui lòng thử lại.' });
      }
      return res.status(401).json({ message: 'Phiên quản trị không hợp lệ.' });
    }
  }

  const permit = (permission) => (req, res, next) => (
    req.adminPermissions?.includes('*') || req.adminPermissions?.includes(permission)
      ? next()
      : res.status(403).json({ message: `Thiếu quyền ${permission}.` })
  );

  return { requireAdmin, permit };
}

module.exports = { createAdminGuard };
