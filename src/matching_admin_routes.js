const express = require('express');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { MATCHING_PRESETS } = require('./matching_policy');

function jwtSecret() {
  const secret = String(process.env.JWT_ACCESS_SECRET || '').trim();
  if (secret.length < 32) throw new Error('JWT_ACCESS_SECRET chưa được cấu hình an toàn.');
  return secret;
}

function safeObjectId(value) {
  try { return new ObjectId(String(value)); } catch (_) { return null; }
}

function iso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function createMatchingAdminRouter({ getDb, getMatching }) {
  const router = express.Router();

  async function requireAdmin(req, res, next) {
    try {
      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'Thiếu Access Token quản trị.' });
      const payload = jwt.verify(header.slice(7).trim(), jwtSecret());
      const userId = safeObjectId(payload.sub || payload.userId);
      if (!userId) return res.status(401).json({ message: 'Access Token không hợp lệ.' });
      const db = getDb();
      if (!db) return res.status(503).json({ message: 'Database chưa sẵn sàng.' });
      const user = await db.collection('users').findOne({ _id: userId, roles: 'ADMIN' });
      if (!user) return res.status(403).json({ message: 'Không có quyền ADMIN.' });
      const status = String(user.status || 'ACTIVE').toUpperCase();
      if (['BLOCKED', 'DISABLED', 'DELETED', 'INACTIVE'].includes(status)) {
        return res.status(403).json({ message: 'Tài khoản quản trị đã bị khóa.' });
      }
      req.admin = user;
      next();
    } catch (_) {
      return res.status(401).json({ message: 'Phiên quản trị không hợp lệ hoặc đã hết hạn.' });
    }
  }

  async function audit(req, action, targetType, targetId, payload = {}) {
    try {
      await getDb().collection('matching_admin_logs').insertOne({
        action,
        targetType,
        targetId: targetId ? String(targetId) : null,
        adminId: req.admin?._id || null,
        adminName: req.admin?.fullName || null,
        payload,
        createdAt: new Date(),
      });
    } catch (_) {}
  }

  function engine() {
    const matching = getMatching?.();
    if (!matching) throw new Error('Matching Engine chưa sẵn sàng.');
    return matching;
  }

  router.use(requireAdmin);

  async function requirePermission(permission, req, res, next) {
    try {
      const codes = [...new Set([
        ...(Array.isArray(req.admin?.adminRoleCodes) ? req.admin.adminRoleCodes : []),
        ...(Array.isArray(req.admin?.roleCodes) ? req.admin.roleCodes : []),
      ].map((x) => String(x || '').trim().toUpperCase()).filter(Boolean))];
      // Legacy ADMIN accounts created before granular RBAC are treated as SUPER_ADMIN.
      if (!codes.length || codes.includes('SUPER_ADMIN')) return next();
      const roles = await getDb().collection('admin_roles').find({ code: { $in: codes }, status: 'ACTIVE' }).toArray();
      const permissions = new Set(roles.flatMap((role) => Array.isArray(role.permissions) ? role.permissions : []));
      if (!permissions.has(permission)) return res.status(403).json({ message: `Thiếu quyền ${permission}.` });
      return next();
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }

  const canView = (req, res, next) => requirePermission('matching.view', req, res, next);
  const canManage = (req, res, next) => requirePermission('matching.manage', req, res, next);
  const canDispatch = (req, res, next) => requirePermission('matching.dispatch', req, res, next);

  router.get('/policy', canView, async (req, res) => {
    try {
      const policy = await engine().getMatchingPolicy({ refresh: req.query.refresh === '1' });
      return res.json({ policy, presets: MATCHING_PRESETS });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.put('/policy', canManage, async (req, res) => {
    try {
      const policy = await engine().saveMatchingPolicy(req.body || {}, req.admin._id);
      await audit(req, 'MATCHING_POLICY_UPDATE', 'MATCHING_POLICY', 'BIKE_MATCHING_POLICY', { policy });
      return res.json({ ok: true, policy });
    } catch (error) { return res.status(400).json({ message: error.message }); }
  });

  router.get('/stats', canView, async (_req, res) => {
    try {
      const matching = engine();
      const [stats, policy] = await Promise.all([
        matching.stats(),
        matching.getMatchingPolicy(),
      ]);
      return res.json({ ...stats, policy });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/queue', canView, async (req, res) => {
    try {
      const db = getDb();
      const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
      const rows = await db.collection('bookings').find({ status: { $in: ['SEARCHING', 'OFFERED', 'NO_DRIVER'] } })
        .sort({ createdAt: 1 }).limit(limit).toArray();
      return res.json(rows.map((b) => ({
        id: String(b._id),
        code: b.bookingCode || String(b._id),
        status: b.status,
        pickup: b.pickup?.address || b.pickup?.addressText || '',
        destination: b.destination?.address || b.destination?.addressText || '',
        customerTotal: Number(b.pricing?.customerTotal || b.pricing?.total || 0),
        currentDriverId: b.dispatch?.currentDriverId ? String(b.dispatch.currentDriverId) : null,
        dispatch: b.dispatch || null,
        createdAt: iso(b.createdAt),
      })));
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/candidates/:bookingId', canView, async (req, res) => {
    try {
      const result = await engine().previewCandidates(req.params.bookingId, { includeNoGps: true });
      return res.json(result);
    } catch (error) { return res.status(400).json({ message: error.message }); }
  });

  router.post('/dispatch/:bookingId', canDispatch, async (req, res) => {
    try {
      const driverId = String(req.body?.driverId || '').trim();
      const reason = String(req.body?.reason || '').trim();
      let result;
      if (driverId) {
        result = await engine().manualDispatchToDriver(req.params.bookingId, driverId, {
          adminId: req.admin._id,
          reason,
        });
        await audit(req, 'MATCHING_MANUAL_DISPATCH', 'BOOKING', req.params.bookingId, { driverId, reason });
      } else {
        result = await engine().adminRedispatch(req.params.bookingId, {
          adminId: req.admin._id,
          reason,
        });
        await audit(req, 'MATCHING_ALGO_REDISPATCH', 'BOOKING', req.params.bookingId, { reason });
      }
      return res.json({ ok: true, result });
    } catch (error) { return res.status(400).json({ message: error.message }); }
  });

  router.post('/cancel-offer/:bookingId', canDispatch, async (req, res) => {
    try {
      const reason = String(req.body?.reason || 'ADMIN_CANCELLED_OFFER').trim();
      const result = await engine().cancelActiveOffersForBooking(req.params.bookingId, reason, req.admin._id);
      await audit(req, 'MATCHING_CANCEL_OFFER', 'BOOKING', req.params.bookingId, { reason, ...result });
      return res.json({ ok: true, result });
    } catch (error) { return res.status(400).json({ message: error.message }); }
  });

  router.post('/drivers/:driverId/priority', canDispatch, async (req, res) => {
    try {
      const db = getDb();
      const driverId = safeObjectId(req.params.driverId);
      if (!driverId) return res.status(400).json({ message: 'Driver id không hợp lệ.' });
      const priority = Math.max(-10, Math.min(10, Math.round(Number(req.body?.priority || 0))));
      const reason = String(req.body?.reason || '').trim();
      const minutes = Math.max(0, Math.min(7 * 24 * 60, Math.round(Number(req.body?.minutes || 0))));
      const until = priority !== 0 && minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
      const update = await db.collection('drivers').findOneAndUpdate(
        { _id: driverId },
        {
          $set: {
            matchingPriority: priority,
            matchingPriorityReason: reason || null,
            matchingPriorityUntil: until,
            matchingPriorityUpdatedBy: req.admin._id,
            matchingPriorityUpdatedAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after' },
      );
      const driver = update?.value || update;
      if (!driver?._id) return res.status(404).json({ message: 'Không tìm thấy tài xế.' });
      await audit(req, 'MATCHING_DRIVER_PRIORITY', 'DRIVER', driverId, { priority, reason, minutes, until });
      return res.json({ ok: true, priority, reason, until: iso(until) });
    } catch (error) { return res.status(400).json({ message: error.message }); }
  });

  router.get('/logs', canView, async (req, res) => {
    try {
      const db = getDb();
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 80)));
      const [adminLogs, offers] = await Promise.all([
        db.collection('matching_admin_logs').find({}).sort({ createdAt: -1 }).limit(limit).toArray(),
        db.collection('driver_offers').find({}).sort({ sentAt: -1 }).limit(limit).toArray(),
      ]);
      return res.json({
        adminLogs: adminLogs.map((x) => ({
          id: String(x._id), action: x.action, targetType: x.targetType, targetId: x.targetId,
          adminId: x.adminId ? String(x.adminId) : null, adminName: x.adminName || null,
          payload: x.payload || {}, createdAt: iso(x.createdAt),
        })),
        offers: offers.map((x) => ({
          id: String(x._id), bookingId: x.bookingId ? String(x.bookingId) : null,
          driverId: x.driverId ? String(x.driverId) : null, status: x.status,
          distanceKm: x.distanceToPickupKm ?? null, score: x.matchingScore ?? null,
          rank: x.matchingRank ?? null, source: x.matchingSource || null,
          strategy: x.matchingStrategy || null, dispatchMode: x.dispatchMode || null,
          attemptNo: x.attemptNo || null, sentAt: iso(x.sentAt), respondedAt: iso(x.respondedAt),
          expiresAt: iso(x.expiresAt), reason: x.reason || null,
        })),
      });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  return router;
}

module.exports = { createMatchingAdminRouter };
