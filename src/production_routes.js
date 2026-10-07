const express = require('express');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

function oid(v) { try { return new ObjectId(String(v)); } catch (_) { return null; } }
function secret() { const s = String(process.env.JWT_ACCESS_SECRET || '').trim(); if (s.length < 32) throw new Error('JWT_ACCESS_SECRET chưa an toàn.'); return s; }

function createProductionPublicRouter({ getProduction }) {
  const r = express.Router();
  r.get('/app-config', async (req, res) => {
    try {
      const config = await getProduction().loadProductionConfig();
      return res.json(getProduction().appConfigFor({ role: req.query.role || 'CUSTOMER', appVersion: req.query.version || '0.0.0', config }));
    } catch (e) { return res.status(500).json({ message: e.message }); }
  });
  return r;
}

function createProductionDriverRouter({ getDb, getProduction, findDriverByPhone }) {
  const r = express.Router();
  r.get('/health', async (req, res) => {
    try {
      const found = await findDriverByPhone(req.auth.user.phone);
      if (!found) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      return res.json(await getProduction().driverHealth({ driver: found.driver, user: found.user }));
    } catch (e) { return res.status(500).json({ message: e.message }); }
  });
  return r;
}

function createProductionAdminRouter({ getDb, getProduction, getPlatform }) {
  const r = express.Router();
  r.use(async (req, res, next) => {
    try {
      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'Thiếu Access Token quản trị.' });
      const payload = jwt.verify(header.slice(7).trim(), secret());
      const id = oid(payload.sub || payload.userId);
      const user = id ? await getDb().collection('users').findOne({ _id: id, roles: 'ADMIN' }) : null;
      if (!user) return res.status(403).json({ message: 'Không có quyền ADMIN.' });
      const status = String(user.status || 'ACTIVE').toUpperCase();
      if (['BLOCKED','DISABLED','DELETED','INACTIVE'].includes(status)) return res.status(403).json({ message: 'Tài khoản Admin đã bị khóa.' });
      const codes = Array.isArray(user.adminRoleCodes) ? user.adminRoleCodes : Array.isArray(user.roleCodes) ? user.roleCodes : [];
      if (!codes.length || codes.includes('SUPER_ADMIN')) req.permissions = ['*'];
      else {
        const roles = await getDb().collection('admin_roles').find({ code: { $in: codes }, status: 'ACTIVE' }).toArray();
        req.permissions = [...new Set(roles.flatMap((x) => Array.isArray(x.permissions) ? x.permissions : []))];
      }
      req.admin = user;
      next();
    } catch (_) { return res.status(401).json({ message: 'Phiên quản trị không hợp lệ.' }); }
  });
  const permit = (permission) => (req, res, next) => req.permissions.includes('*') || req.permissions.includes(permission) ? next() : res.status(403).json({ message: `Thiếu quyền ${permission}.` });
  const permitAny = (...permissions) => (req, res, next) => req.permissions.includes('*') || permissions.some((permission) => req.permissions.includes(permission)) ? next() : res.status(403).json({ message: `Thiếu một trong các quyền: ${permissions.join(', ')}.` });

  r.get('/health', permit('settings.view'), async (_req, res) => {
    try { return res.json(await getProduction().systemHealth()); } catch (e) { return res.status(500).json({ message: e.message }); }
  });
  r.get('/finance/summary', permitAny('settlement.view','settlements.view','settings.view'), async (_req, res) => {
    try { return res.json(await getProduction().financialSummary()); } catch (e) { return res.status(500).json({ message: e.message }); }
  });
  r.get('/config', permit('settings.view'), async (_req, res) => {
    try { return res.json(await getProduction().loadProductionConfig()); } catch (e) { return res.status(500).json({ message: e.message }); }
  });
  r.put('/config', permit('settings.manage'), async (req, res) => {
    try {
      const value = await getProduction().saveProductionConfig(req.body || {}, req.admin._id);
      await getDb().collection('audit_logs').insertOne({ actorType: 'ADMIN', actorId: req.admin._id, action: 'V73_PRODUCTION_CONFIG_UPDATE', entityType: 'APP_SETTINGS', entityId: 'V73_PRODUCTION_CONFIG', after: value, createdAt: new Date() });
      return res.json(value);
    } catch (e) { return res.status(400).json({ message: e.message }); }
  });
  r.post('/finance/reconcile', permitAny('settlement.manage','settlements.manage','settings.manage'), async (_req, res) => {
    try {
      const rows = await getDb().collection('bookings').find({ status: 'COMPLETED' }).sort({ completedAt: 1 }).limit(500).toArray();
      let appSettled = 0;
      let appPartial = 0;
      let ledgerPosted = 0;
      const failures = [];
      for (const booking of rows) {
        try {
          const appResult = await getPlatform().reconcileCompletedBookingSettlement(booking);
          if (appResult?.status === 'SETTLED') appSettled += 1;
          else if (appResult?.status === 'PARTIAL' || appResult?.status === 'FAILED') appPartial += 1;
        } catch (error) {
          appPartial += 1;
          failures.push({ bookingId: String(booking._id), stage: error?.settlementStage || 'APP_SETTLEMENT', message: error.message });
        }
        try {
          await getProduction().postSettlement(booking);
          ledgerPosted += 1;
        } catch (error) {
          failures.push({ bookingId: String(booking._id), stage: 'PLATFORM_LEDGER', message: error.message });
        }
      }
      return res.json({
        ok: failures.length === 0,
        scanned: rows.length,
        appSettled,
        appPartial,
        ledgerPosted,
        failures: failures.slice(0, 100),
      });
    } catch (e) { return res.status(500).json({ message: e.message }); }
  });
  return r;
}

module.exports = { createProductionPublicRouter, createProductionDriverRouter, createProductionAdminRouter };
