const express = require('express');
const { createAdminGuard } = require('./admin_guard');
const { ObjectId } = require('mongodb');

function oid(value) {
  try { return value instanceof ObjectId ? value : new ObjectId(String(value)); }
  catch (_) { return null; }
}

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function parseIdentifiers(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 500);
  }
  return [...new Set(
    String(value || '')
      .split(/[\n,;]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  )].slice(0, 500);
}

function createBroadcastRouter({ getDb, getNotifications }) {
  const router = express.Router();

  // Use the common admin guard: accounts without assigned roles must not
  // inherit SUPER_ADMIN rights when broadcasting to all users.
  const { requireAdmin, permit } = createAdminGuard({ getDb });
  router.use(requireAdmin);
  const permitSend = (req, res, next) => {
    const permissions = req.adminPermissions || [];
    if (permissions.includes('*') || permissions.includes('broadcast.send') || permissions.includes('broadcast.manage')) return next();
    return res.status(403).json({ message: 'Thiếu quyền broadcast.send.' });
  };

  async function resolveCustomers(identifiers = null) {
    const db = getDb();

    if (!identifiers?.length) {
      return db.collection('users')
        .find({ roles: 'CUSTOMER', status: { $ne: 'BLOCKED' } })
        .project({ _id: 1, phone: 1, email: 1, fullName: 1 })
        .limit(10000)
        .toArray();
    }

    const ids = identifiers.map(oid).filter(Boolean);
    const text = identifiers.filter((x) => !oid(x));
    const or = [];

    if (ids.length) or.push({ _id: { $in: ids } });
    if (text.length) {
      or.push({ phone: { $in: text } });
      or.push({ email: { $in: text } });
    }

    if (!or.length) return [];

    return db.collection('users')
      .find({
        roles: 'CUSTOMER',
        status: { $ne: 'BLOCKED' },
        $or: or,
      })
      .project({ _id: 1, phone: 1, email: 1, fullName: 1 })
      .limit(500)
      .toArray();
  }

  async function resolveDrivers({ onlineOnly = false, identifiers = null } = {}) {
    const db = getDb();
    const query = { approvalStatus: 'APPROVED', kycStatus: 'APPROVED' };

    if (onlineOnly) {
      query.onlineStatus = { $in: ['ONLINE', 'BUSY'] };
    }

    if (identifiers?.length) {
      const ids = identifiers.map(oid).filter(Boolean);
      const text = identifiers.filter((x) => !oid(x));
      const or = [];

      if (ids.length) or.push({ _id: { $in: ids } });
      if (text.length) {
        or.push({ phone: { $in: text } });
        or.push({ email: { $in: text } });
      }

      if (!or.length) return [];
      query.$or = or;
    }

    return db.collection('drivers')
      .find(query)
      .project({
        _id: 1,
        phone: 1,
        email: 1,
        fullName: 1,
        name: 1,
        onlineStatus: 1,
      })
      .limit(10000)
      .toArray();
  }

  async function resolveRecipients({ audience, specificType, identifiers }) {
    const recipients = [];

    if (audience === 'CUSTOMERS') {
      for (const row of await resolveCustomers()) {
        recipients.push({ targetType: 'CUSTOMER', targetId: row._id, row });
      }
    } else if (audience === 'DRIVERS') {
      for (const row of await resolveDrivers()) {
        recipients.push({ targetType: 'DRIVER', targetId: row._id, row });
      }
    } else if (audience === 'BOTH') {
      const [customers, drivers] = await Promise.all([
        resolveCustomers(),
        resolveDrivers(),
      ]);
      for (const row of customers) {
        recipients.push({ targetType: 'CUSTOMER', targetId: row._id, row });
      }
      for (const row of drivers) {
        recipients.push({ targetType: 'DRIVER', targetId: row._id, row });
      }
    } else if (audience === 'ONLINE_DRIVERS') {
      for (const row of await resolveDrivers({ onlineOnly: true })) {
        recipients.push({ targetType: 'DRIVER', targetId: row._id, row });
      }
    } else if (audience === 'SPECIFIC') {
      const ids = parseIdentifiers(identifiers);
      if (!ids.length) return [];

      if (specificType === 'CUSTOMER' || specificType === 'BOTH') {
        for (const row of await resolveCustomers(ids)) {
          recipients.push({ targetType: 'CUSTOMER', targetId: row._id, row });
        }
      }

      if (specificType === 'DRIVER' || specificType === 'BOTH') {
        for (const row of await resolveDrivers({ identifiers: ids })) {
          recipients.push({ targetType: 'DRIVER', targetId: row._id, row });
        }
      }
    }

    const unique = new Map();
    for (const item of recipients) {
      unique.set(`${item.targetType}:${String(item.targetId)}`, item);
    }

    return [...unique.values()];
  }

  function parseRequest(req) {
    const title = cleanText(req.body?.title, 120);
    const body = cleanText(req.body?.body, 1500);
    const level = Number(req.body?.level ?? 4);
    const audience = String(req.body?.audience || 'BOTH').toUpperCase();
    const specificType = String(req.body?.specificType || 'BOTH').toUpperCase();
    const identifiers = parseIdentifiers(req.body?.identifiers);
    const expiryHours = Number(req.body?.expiryHours || 24);
    const deliveryMode = String(req.body?.deliveryMode || 'PUSH_AND_IN_APP').toUpperCase();
    if (title.length < 2 || body.length < 2) throw Object.assign(new Error('Tiêu đề và nội dung phải có tối thiểu 2 ký tự.'), { httpStatus: 400 });
    if (!Number.isInteger(level) || level < 1 || level > 4) throw Object.assign(new Error('Cấp thông báo không hợp lệ.'), { httpStatus: 400 });
    if (!['CUSTOMERS','DRIVERS','BOTH','ONLINE_DRIVERS','SPECIFIC'].includes(audience)) throw Object.assign(new Error('Nhóm nhận không hợp lệ.'), { httpStatus: 400 });
    if (audience === 'SPECIFIC' && (!identifiers.length || !['CUSTOMER','DRIVER','BOTH'].includes(specificType))) throw Object.assign(new Error('Cần cung cấp người nhận cụ thể và loại tài khoản.'), { httpStatus: 400 });
    if (!Number.isInteger(expiryHours) || expiryHours < 1 || expiryHours > 168) throw Object.assign(new Error('Thời gian hiệu lực không hợp lệ.'), { httpStatus: 400 });
    if (!['PUSH_AND_IN_APP','IN_APP_ONLY'].includes(deliveryMode)) throw Object.assign(new Error('Kênh thông báo không hợp lệ.'), { httpStatus: 400 });
    return { title, body, level, audience, specificType, identifiers, expiryHours, deliveryMode };
  }

  async function pushCoverage(recipients) {
    const active = new Set();
    const db = getDb();
    // Chunk $in queries to keep large broadcasts within MongoDB limits.
    for (const targetType of ['CUSTOMER', 'DRIVER']) {
      const ids = recipients.filter(x => x.targetType === targetType).map(x => x.targetId);
      for (let start = 0; start < ids.length; start += 400) {
        const rows = await db.collection('device_tokens').find({
          userType: targetType,
          userId: { $in: ids.slice(start, start + 400) },
          enabled: true,
        }).project({ userId: 1 }).toArray();
        for (const row of rows) active.add(`${targetType}:${String(row.userId)}`);
      }
    }
    return active.size;
  }

  async function prepare(req) {
    const input = parseRequest(req);
    const recipients = await resolveRecipients(input);
    if (!recipients.length) throw Object.assign(new Error('Không tìm thấy tài khoản nhận thông báo.'), { httpStatus: 400 });
    const fcmConfigured = Boolean(getNotifications()?.isConfigured?.());
    const pushEligible = input.deliveryMode === 'IN_APP_ONLY' ? 0 : await pushCoverage(recipients);
    return { input, recipients, fcmConfigured, pushEligible };
  }

  router.get('/push-status', permit('broadcast.view'), async (_req, res) => {
    try {
      const db = getDb();
      const [customerTokens, driverTokens] = await Promise.all([
        db.collection('device_tokens').countDocuments({ userType:'CUSTOMER', enabled:true }),
        db.collection('device_tokens').countDocuments({ userType:'DRIVER', enabled:true }),
      ]);
      return res.json({
        fcmConfigured: Boolean(getNotifications()?.isConfigured?.()),
        activeTokens: { customers: customerTokens, drivers: driverTokens },
        note: 'Số token đang bật không phải số thiết bị đã nhận push thành công.',
      });
    } catch (error) { return res.status(503).json({ message: error.message }); }
  });

  router.post('/preview', permitSend, async (req, res) => {
    try {
      const { input, recipients, fcmConfigured, pushEligible } = await prepare(req);
      return res.json({
        audience: input.audience, deliveryMode: input.deliveryMode,
        totalTargets: recipients.length, fcmConfigured, pushEligible,
        withoutPushToken: input.deliveryMode === 'IN_APP_ONLY' ? null : recipients.length - pushEligible,
        canSubmit: input.deliveryMode === 'IN_APP_ONLY' || (fcmConfigured && pushEligible > 0),
      });
    } catch (error) { return res.status(error.httpStatus || 503).json({ message: error.message }); }
  });

  async function broadcastStats(broadcastId) {
    const db = getDb();
    const id = oid(broadcastId);
    if (!id) return {
      total: 0,
      sent: 0,
      failed: 0,
      noDevice: 0,
      pending: 0,
      acknowledged: 0,
      read: 0,
    };

    const [outboxStats, notificationStats] = await Promise.all([
      db.collection('notification_outbox').aggregate([
        { $match: { broadcastId: id } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).toArray(),
      db.collection('notifications').aggregate([
        { $match: { broadcastId: id } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            read: {
              $sum: {
                $cond: [{ $ne: ['$readAt', null] }, 1, 0],
              },
            },
            acknowledged: {
              $sum: {
                $cond: [{ $ne: ['$acknowledgedAt', null] }, 1, 0],
              },
            },
          },
        },
      ]).toArray(),
    ]);

    const byStatus = Object.fromEntries(
      outboxStats.map((item) => [String(item._id || 'UNKNOWN'), item.count]),
    );
    const n = notificationStats[0] || {};

    return {
      total: Number(n.total || 0),
      sent: Number(byStatus.SENT || 0) + Number(byStatus.IN_APP || 0),
      fcmSent: Number(byStatus.SENT || 0),
      inApp: Number(byStatus.IN_APP || 0),
      failed: Number(byStatus.FAILED || 0),
      noDevice: Number(byStatus.NO_DEVICE || 0),
      pending:
        Number(byStatus.PENDING || 0) +
        Number(byStatus.PROCESSING || 0) +
        Number(byStatus.RETRY || 0),
      expired: Number(byStatus.EXPIRED || 0),
      read: Number(n.read || 0),
      acknowledged: Number(n.acknowledged || 0),
    };
  }

  router.get('/', permit('broadcast.view'), async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 40));
      const rows = await getDb().collection('admin_broadcasts')
        .find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      const result = [];
      for (const row of rows) {
        result.push({
          ...row,
          _id: String(row._id),
          createdBy: row.createdBy ? String(row.createdBy) : null,
          stats: await broadcastStats(row._id),
        });
      }

      return res.json(result);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.get('/:id', permit('broadcast.view'), async (req, res) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ message: 'Broadcast id không hợp lệ.' });

      const broadcast = await getDb().collection('admin_broadcasts').findOne({ _id: id });
      if (!broadcast) return res.status(404).json({ message: 'Không tìm thấy thông báo.' });

      const deliveries = await getDb().collection('notifications')
        .find({ broadcastId: id })
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray();

      return res.json({
        broadcast: {
          ...broadcast,
          _id: String(broadcast._id),
          createdBy: broadcast.createdBy ? String(broadcast.createdBy) : null,
        },
        stats: await broadcastStats(id),
        deliveries: deliveries.map((item) => ({
          id: String(item._id),
          targetType: item.targetType,
          targetId: String(item.targetId),
          status: item.status,
          readAt: item.readAt,
          acknowledgedAt: item.acknowledgedAt,
          createdAt: item.createdAt,
        })),
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.post('/', permitSend, async (req, res) => {
    try {
      const { input, recipients, fcmConfigured, pushEligible } = await prepare(req);
      const { title, body, level, audience, specificType, identifiers, expiryHours, deliveryMode } = input;
      if (deliveryMode === 'PUSH_AND_IN_APP' && !fcmConfigured) {
        return res.status(409).json({ code: 'FCM_NOT_CONFIGURED', message: 'FCM chưa được cấu hình trên Backend. Hãy bật FCM hoặc chọn Chỉ trong ứng dụng.' });
      }
      if (deliveryMode === 'PUSH_AND_IN_APP' && pushEligible === 0) {
        return res.status(409).json({ code: 'NO_PUSH_TOKENS', message: 'Không có thiết bị User/Driver nào đăng ký token push hợp lệ cho nhóm nhận.' });
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + expiryHours * 60 * 60 * 1000);
      const broadcastDoc = {
        title,
        body,
        level,
        requireAck: level === 1,
        displayMode: level === 1 ? 'MODAL' : level === 2 ? 'BANNER' : 'CENTER',
        audience,
        specificType: audience === 'SPECIFIC' ? specificType : null,
        identifiers: audience === 'SPECIFIC' ? identifiers : [],
        expiryHours,
        deliveryMode,
        pushEligible,
        expiresAt,
        totalTargets: recipients.length,
        status: 'QUEUED',
        createdBy: req.admin._id,
        createdAt: now,
        updatedAt: now,
        sentAt: null,
      };

      const inserted = await getDb().collection('admin_broadcasts').insertOne(
        broadcastDoc,
      );
      const broadcastId = inserted.insertedId;

      const batchSize = 25;
      for (let start = 0; start < recipients.length; start += batchSize) {
        const batch = recipients.slice(start, start + batchSize);

        await Promise.all(
          batch.map((recipient) =>
            getNotifications().enqueue({
              dedupeKey:
                `ADMIN_BROADCAST:${String(broadcastId)}:` +
                `${recipient.targetType}:${String(recipient.targetId)}`,
              type: 'ADMIN_BROADCAST',
              targetType: recipient.targetType,
              targetId: recipient.targetId,
              title,
              body,
              priority: level === 1 ? 'CRITICAL' : level === 2 ? 'HIGH' : level === 3 ? 'NORMAL' : 'LOW',
              broadcastId,
              level,
              requireAck: level === 1,
              expiresAt,
              source: 'ADMIN',
              deliveryMode,
              data: {
                type: 'ADMIN_BROADCAST',
                source: 'ADMIN',
                level: String(level),
                displayMode: level === 1 ? 'MODAL' : level === 2 ? 'BANNER' : 'CENTER',
                requireAck: level === 1 ? 'true' : 'false',
              },
            }),
          ),
        );
      }

      await getDb().collection('admin_broadcasts').updateOne(
        { _id: broadcastId },
        {
          $set: {
            status: 'QUEUED',
            queuedAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );

      return res.status(201).json({
        ok: true,
        id: String(broadcastId),
        totalTargets: recipients.length,
        pushEligible,
        deliveryMode,
        status: 'QUEUED',
        level,
        requireAck: level === 1,
      });
    } catch (error) {
      return res.status(error.httpStatus || 500).json({ message: error.message });
    }
  });

  router.delete('/:id', permitSend, async (req, res) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ message: 'Broadcast id không hợp lệ.' });
      const db = getDb();
      const broadcast = await db.collection('admin_broadcasts').findOne({ _id: id });
      if (!broadcast) return res.status(404).json({ message: 'Không tìm thấy thông báo.' });

      const [notifications, outbox] = await Promise.all([
        db.collection('notifications').deleteMany({ broadcastId: id }),
        db.collection('notification_outbox').deleteMany({ broadcastId: id }),
      ]);
      await db.collection('admin_broadcasts').deleteOne({ _id: id });

      await db.collection('audit_logs').insertOne({
        actorId: req.admin._id,
        action: 'BROADCAST_DELETE',
        resource: 'admin_broadcasts',
        resourceId: id,
        meta: {
          title: broadcast.title,
          deletedNotifications: notifications.deletedCount || 0,
          deletedOutbox: outbox.deletedCount || 0,
        },
        createdAt: new Date(),
      }).catch(() => {});

      return res.json({
        ok: true,
        deletedNotifications: notifications.deletedCount || 0,
        deletedOutbox: outbox.deletedCount || 0,
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  return router;
}

module.exports = { createBroadcastRouter };
