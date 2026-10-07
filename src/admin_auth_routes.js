const express = require('express');
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const {
  bearerToken,
  ensureAdminSessionIndexes,
  issueAdminSession,
  revokeAdminSession,
  verifyAdminSession,
} = require('./admin_session');

function safeObjectId(value) {
  try {
    return new ObjectId(String(value));
  } catch (_) {
    return null;
  }
}

function publicAdmin(user) {
  return {
    id: String(user._id),
    fullName: user.fullName || 'Quản trị viên',
    phone: user.phone || null,
    email: user.email || null,
    roles: Array.isArray(user.roles) ? user.roles : [],
    status: user.status || 'ACTIVE',
  };
}

function createAdminAuthRouter({ getDb }) {
  const router = express.Router();
  let indexesReadyFor = null;

  async function ensureIndexes(db) {
    if (indexesReadyFor === db) return;
    await ensureAdminSessionIndexes(db);
    indexesReadyFor = db;
  }

  // Basic in-memory brute-force protection for development/local deployment.
  // Production should move rate limiting to Redis/reverse proxy.
  const attempts = new Map();
  const windowMs = 10 * 60 * 1000;
  const maxAttempts = 8;

  function clientKey(req) {
    return String(
      req.headers['x-forwarded-for'] ||
      req.socket?.remoteAddress ||
      'unknown'
    ).split(',')[0].trim();
  }

  function checkRate(req, res, next) {
    const key = clientKey(req);
    const now = Date.now();
    const current = attempts.get(key);

    if (!current || now - current.startedAt > windowMs) {
      attempts.set(key, { startedAt: now, count: 0 });
      return next();
    }

    if (current.count >= maxAttempts) {
      return res.status(429).json({
        message: 'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau.',
      });
    }

    next();
  }

  function noteFailure(req) {
    const key = clientKey(req);
    const now = Date.now();
    const current = attempts.get(key);

    if (!current || now - current.startedAt > windowMs) {
      attempts.set(key, { startedAt: now, count: 1 });
    } else {
      current.count += 1;
      attempts.set(key, current);
    }
  }

  function clearFailures(req) {
    attempts.delete(clientKey(req));
  }

  async function requireAdmin(req, res, next) {
    try {
      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Thiếu Access Token.' });
      }

      const db = getDb();
      if (!db) {
        return res.status(503).json({ message: 'Database chưa sẵn sàng.' });
      }
      const verified = await verifyAdminSession({ db, token: bearerToken(req) });
      const userId = verified.userId;

      if (!userId) {
        return res.status(401).json({ message: 'Access Token không hợp lệ.' });
      }

      const user = await db.collection('users').findOne({
        _id: userId,
        roles: 'ADMIN',
      });

      if (!user) {
        return res.status(403).json({ message: 'Tài khoản không có quyền ADMIN.' });
      }

      const status = String(user.status || 'ACTIVE').toUpperCase();
      if (['BLOCKED', 'DISABLED', 'DELETED', 'INACTIVE'].includes(status)) {
        return res.status(403).json({ message: 'Tài khoản quản trị đã bị khóa.' });
      }

      req.admin = user;
      req.adminSession = verified;
      next();
    } catch (error) {
      return res.status(401).json({
        code: error.code || 'INVALID_TOKEN',
        message: error.message || 'Phiên quản trị không hợp lệ hoặc đã hết hạn.',
      });
    }
  }

  router.post('/login', checkRate, async (req, res) => {
    try {
      const db = getDb();
      if (!db) {
        return res.status(503).json({ message: 'Database chưa sẵn sàng.' });
      }
      await ensureIndexes(db);

      const login = String(
        req.body?.login ||
        req.body?.phone ||
        req.body?.email ||
        ''
      ).trim();

      const password = String(req.body?.password || '');

      if (!login || !password) {
        return res.status(400).json({
          message: 'Vui lòng nhập tài khoản và mật khẩu.',
        });
      }

      const email = login.toLowerCase();

      const user = await db.collection('users').findOne({
        roles: 'ADMIN',
        $or: [
          { phone: login },
          { email },
        ],
      });

      if (!user || !user.passwordHash) {
        noteFailure(req);
        return res.status(401).json({
          message: 'Tài khoản hoặc mật khẩu không đúng.',
        });
      }

      const status = String(user.status || 'ACTIVE').toUpperCase();
      if (['BLOCKED', 'DISABLED', 'DELETED', 'INACTIVE'].includes(status)) {
        return res.status(403).json({
          message: 'Tài khoản quản trị đã bị khóa.',
        });
      }

      const ok = await bcrypt.compare(password, user.passwordHash);

      if (!ok) {
        noteFailure(req);
        return res.status(401).json({
          message: 'Tài khoản hoặc mật khẩu không đúng.',
        });
      }

      clearFailures(req);

      const session = await issueAdminSession({ db, user, req });
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { lastLoginAt: new Date(), updatedAt: new Date() } },
      );

      return res.json({
        accessToken: session.accessToken,
        expiresInSeconds: session.expiresInSeconds,
        expiresAt: session.expiresAt.toISOString(),
        user: publicAdmin(user),
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.get('/me', requireAdmin, async (req, res) => {
    return res.json({
      user: publicAdmin(req.admin),
      expiresAt: req.adminSession.session.expiresAt.toISOString(),
    });
  });

  router.post('/logout', requireAdmin, async (req, res) => {
    try {
      const db = getDb();
      await revokeAdminSession({
        db,
        sessionId: req.adminSession.session._id,
        reason: 'LOGOUT',
      });
      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  return router;
}

module.exports = { createAdminAuthRouter };
