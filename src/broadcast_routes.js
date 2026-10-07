const express = require('express');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

function oid(value) {
  try { return value instanceof ObjectId ? value : new ObjectId(String(value)); }
  catch (_) { return null; }
}

function jwtSecret() {
  const value = String(process.env.JWT_ACCESS_SECRET || '').trim();
  if (value.length < 32) throw new Error('JWT_ACCESS_SECRET chưa cấu hình an toàn.');
  return value;
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

  async function admin(req, res, next) {
    try {
      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Thiếu token Admin.' });
      }

      const payload = jwt.verify(header.slice(7), jwtSecret());
      const id = oid(payload.sub || payload.userId);
      const user = id
        ? await getDb().collection('users').findOne({ _id: id, roles: 'ADMIN' })
        : null;

      if (!user) return res.status(403).json({ message: 'Không có quyền ADMIN.' });

      req.admin = user;

      const codes = Array.isArray(user.adminRoleCodes)
        ? user.adminRoleCodes
        : Array.isArray(user.roleCodes)
            ? user.roleCodes
            : [];

      if (!codes.length || codes.includes('SUPER_ADMIN')) {
        req.adminPermissions = ['*'];
      } else {
        const roles = await getDb().collection('admin_roles')
          .find({ code: { $in: codes }, status: 'ACTIVE' })
          .toArray();
        req.adminPermissions = [
          ...new Set(
            roles.flatMap((item) =>
              Array.isArray(item.permissions) ? item.permissions : [],
            ),
          ),
        ];
      }

      return next();
    } catch (_) {
      return res.status(401).json({ message: 'Phiên Admin không hợp lệ.' });
    }
  }

  const permit = (permission) => (req, res, next) => {
    if (
      req.adminPermissions.includes('*') ||
      req.adminPermissions.includes(permission)
    ) {
      return next();
    }
    return res.status(403).json({
      message: `Bạn không có quyền ${permission}.`,
    });
  };

  router.use(admin);

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
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
      const page = Math.max(1, Math.round(Number(req.query.page) || 1));
      const paged = req.query.page !== undefined;
      const [rows, total] = await Promise.all([
        getDb().collection('admin_broadcasts').find({}).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
        paged ? getDb().collection('admin_broadcasts').countDocuments({}) : Promise.resolve(0),
      ]);

      // Stats for each row used to run one after another (up to 40 aggregate
      // queries for one 20-row page). Run independent rows in parallel so a
      // page turn waits for the slowest aggregate, not the sum of all of them.
      const result = await Promise.all(rows.map(async (row) => ({
          ...row,
          _id: String(row._id),
          createdBy: row.createdBy ? String(row.createdBy) : null,
          stats: await broadcastStats(row._id),
      })));

      return res.json(paged ? {
        items: result,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      } : result);
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

  router.post('/', permit('broadcast.send'), async (req, res) => {
    try {
      const title = cleanText(req.body?.title, 120);
      const body = cleanText(req.body?.body, 1500);
      const level = Math.min(4, Math.max(1, Math.round(Number(req.body?.level) || 4)));
      const audience = String(req.body?.audience || 'CUSTOMERS').toUpperCase();
      const specificType = String(req.body?.specificType || 'CUSTOMER').toUpperCase();
      const identifiers = parseIdentifiers(req.body?.identifiers);
      const expiryHours = Math.max(
        1,
        Math.min(
          168,
          Number(req.body?.expiryHours) || (level === 1 ? 24 : level === 2 ? 48 : 72),
        ),
      );

      const allowedAudiences = new Set([
        'CUSTOMERS',
        'DRIVERS',
        'BOTH',
        'ONLINE_DRIVERS',
        'SPECIFIC',
      ]);

      if (!title) return res.status(400).json({ message: 'Vui lòng nhập tiêu đề.' });
      if (!body) return res.status(400).json({ message: 'Vui lòng nhập nội dung.' });
      if (!allowedAudiences.has(audience)) {
        return res.status(400).json({ message: 'Nhóm nhận thông báo không hợp lệ.' });
      }
      if (audience === 'SPECIFIC' && !identifiers.length) {
        return res.status(400).json({
          message: 'Vui lòng nhập SĐT, email hoặc ID người nhận.',
        });
      }

      const recipients = await resolveRecipients({
        audience,
        specificType,
        identifiers,
      });

      if (!recipients.length) {
        return res.status(400).json({
          message: 'Không tìm thấy người nhận phù hợp.',
        });
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
        expiresAt,
        totalTargets: recipients.length,
        status: 'SENDING',
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
            status: 'SENT',
            sentAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );

      return res.status(201).json({
        ok: true,
        id: String(broadcastId),
        totalTargets: recipients.length,
        level,
        requireAck: level === 1,
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.delete('/:id', permit('broadcast.send'), async (req, res) => {
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
