const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function bool(v, fallback = false) {
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function oid(value) {
  try { const {ObjectId}=require('mongodb'); return value instanceof ObjectId ? value : new ObjectId(String(value)); }
  catch (_) { return null; }
}

function normalizeNotificationLevel(value) {
  if (value == null || value === '') return 4;
  const level = Math.round(Number(value) || 4);
  return Math.min(4, Math.max(1, level));
}

function createNotificationService({ getDb }) {
  let admin = null;
  let messaging = null;
  let worker = null;
  let started = false;

  function isConfigured() { return Boolean(messaging); }

  async function initFirebase() {
    if (!bool(process.env.FCM_ENABLED, false)) return false;
    try {
      admin = require('firebase-admin');
      if (admin.apps?.length) {
        messaging = admin.messaging();
        return true;
      }

      const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
      const filePath = String(
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        process.env.FIREBASE_SERVICE_ACCOUNT_FILE ||
        '',
      ).trim();

      let credential = null;
      if (rawJson) {
        credential = admin.credential.cert(JSON.parse(rawJson));
      } else if (filePath) {
        const resolved = path.resolve(filePath);
        const value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
        credential = admin.credential.cert(value);
      } else {
        try { credential = admin.credential.applicationDefault(); } catch (_) {}
      }

      if (!credential) return false;
      admin.initializeApp({ credential });
      messaging = admin.messaging();
      return true;
    } catch (error) {
      console.warn('[V7.1 FCM] Chưa sẵn sàng:', error.message);
      messaging = null;
      return false;
    }
  }

  async function databaseReady() {
    const db = getDb();
    if (!db) return;

    await Promise.allSettled([
      db.collection('device_tokens').createIndex(
        { token: 1 },
        { unique: true, name: 'uq_device_token' },
      ),
      db.collection('device_tokens').createIndex(
        { userId: 1, userType: 1, enabled: 1 },
        { name: 'idx_device_owner' },
      ),
      db.collection('notification_outbox').createIndex(
        { dedupeKey: 1 },
        { unique: true, name: 'uq_notification_dedupe' },
      ),
      db.collection('notification_outbox').createIndex(
        { status: 1, nextAttemptAt: 1 },
        { name: 'idx_notification_worker' },
      ),
      db.collection('notification_outbox').createIndex(
        { broadcastId: 1, createdAt: -1 },
        { name: 'idx_notification_broadcast' },
      ),
      db.collection('notifications').createIndex(
        { targetId: 1, createdAt: -1 },
        { name: 'idx_notifications_target' },
      ),
      db.collection('notifications').createIndex(
        { userId: 1, createdAt: -1 },
        { name: 'idx_notifications_user_created_v71' },
      ),
      db.collection('notifications').createIndex(
        { dedupeKey: 1 },
        { unique: true, sparse: true, name: 'uq_notifications_dedupe' },
      ),
      db.collection('notifications').createIndex(
        { broadcastId: 1, acknowledgedAt: 1 },
        { name: 'idx_notification_broadcast_ack' },
      ),
      db.collection('admin_broadcasts').createIndex(
        { createdAt: -1 },
        { name: 'idx_admin_broadcast_created' },
      ),
      db.collection('admin_broadcasts').createIndex(
        { status: 1, createdAt: -1 },
        { name: 'idx_admin_broadcast_status' },
      ),
    ]);
  }

  async function registerDevice({
    userId,
    userType,
    token,
    platform,
    deviceId,
    appVersion,
  }) {
    const db = getDb();
    const now = new Date();
    if (!token) throw new Error('FCM token không được để trống.');

    await db.collection('device_tokens').updateOne(
      { token: String(token) },
      {
        $set: {
          userId,
          userType: String(userType || 'CUSTOMER').toUpperCase(),
          platform: String(platform || 'ANDROID').toUpperCase(),
          deviceId: deviceId || null,
          appVersion: appVersion || null,
          enabled: true,
          lastSeenAt: now,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );

    return { ok: true };
  }

  async function disableDevice({ userId, token, deviceId }) {
    const db = getDb();
    const filter = { userId };
    if (token) filter.token = String(token);
    if (!token && deviceId) filter.deviceId = String(deviceId);

    await db.collection('device_tokens').updateMany(
      filter,
      { $set: { enabled: false, updatedAt: new Date() } },
    );

    return { ok: true };
  }

  async function enqueue({
    dedupeKey,
    type,
    targetType,
    targetId,
    title,
    body,
    data = {},
    bookingId = null,
    offerId = null,
    priority = 'HIGH',
    broadcastId = null,
    level = null,
    requireAck = false,
    expiresAt = null,
    source = null,
  }) {
    const db = getDb();
    const now = new Date();
    const key = dedupeKey || `${type}:${targetId}:${crypto.randomUUID()}`;
    const normalizedTargetType = String(targetType || 'CUSTOMER').toUpperCase();
    const normalizedLevel = normalizeNotificationLevel(level);
    const normalizedBroadcastId = broadcastId ? oid(broadcastId) : null;
    const normalizedExpiresAt = expiresAt ? new Date(expiresAt) : null;
    const effectiveRequireAck = Boolean(requireAck) || normalizedLevel === 1;

    const notificationData = {
      ...(data || {}),
      ...(normalizedBroadcastId ? { broadcastId: String(normalizedBroadcastId) } : {}),
      ...(normalizedLevel ? { level: String(normalizedLevel) } : {}),
      ...(normalizedLevel === 1 ? { displayMode: 'MODAL' } : normalizedLevel === 2 ? { displayMode: 'BANNER' } : { displayMode: 'CENTER' }),
      ...(effectiveRequireAck ? { requireAck: 'true' } : {}),
      ...(normalizedExpiresAt ? { expiresAt: normalizedExpiresAt.toISOString() } : {}),
    };

    const doc = {
      dedupeKey: key,
      type: String(type),
      targetType: normalizedTargetType,
      targetId,
      userId: targetId,
      bookingId,
      offerId,
      broadcastId: normalizedBroadcastId,
      level: normalizedLevel,
      requireAck: effectiveRequireAck,
      expiresAt: normalizedExpiresAt,
      source: source || null,
      title: String(title || 'TH79 iMove'),
      body: String(body || ''),
      data: Object.fromEntries(
        Object.entries(notificationData).map(([k, v]) => [
          k,
          v == null ? '' : String(v),
        ]),
      ),
      priority,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: now,
      sentAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const result = await db.collection('notification_outbox').insertOne(doc);

      try {
        await db.collection('notifications').updateOne(
          { dedupeKey: key },
          {
            $setOnInsert: {
              ...doc,
              _id: result.insertedId,
              readAt: null,
              openedAt: null,
              deliveredAt: null,
              acknowledgedAt: null,
            },
          },
          { upsert: true },
        );
      } catch (persistError) {
        await db.collection('notification_outbox').updateOne(
          { _id: result.insertedId },
          {
            $set: {
              status: 'FAILED',
              lastError: `NOTIFICATION_PERSIST_FAILED: ${persistError.message}`,
              updatedAt: new Date(),
            },
          },
        ).catch(() => {});
        throw persistError;
      }

      return { ...doc, _id: result.insertedId, duplicate: false };
    } catch (error) {
      if (error?.code === 11000) {
        const existing = await db
          .collection('notification_outbox')
          .findOne({ dedupeKey: key });
        return { ...existing, duplicate: true };
      }
      throw error;
    }
  }

  function retryDelay(attempt) {
    const values = String(process.env.FCM_RETRY_SECONDS || '3,10,30')
      .split(',')
      .map((v) => Math.max(1, Number(v) || 1));
    return values[
      Math.min(Math.max(0, attempt - 1), values.length - 1)
    ] * 1000;
  }

  async function processOne(outbox) {
    const db = getDb();
    const attempt = Number(outbox.attempts || 0) + 1;
    const maxAttempts = Math.max(
      1,
      Number(process.env.FCM_MAX_RETRIES || 3),
    );

    if (outbox.expiresAt && new Date(outbox.expiresAt) <= new Date()) {
      await db.collection('notification_outbox').updateOne(
        { _id: outbox._id },
        {
          $set: {
            status: 'EXPIRED',
            attempts: attempt,
            lastError: 'NOTIFICATION_EXPIRED',
            updatedAt: new Date(),
          },
        },
      );
      return;
    }

    const tokens = await db.collection('device_tokens').find({
      userId: outbox.targetId,
      userType: outbox.targetType,
      enabled: true,
    }).toArray();

    // MongoDB is the source of truth for notifications in iMove 1.6.0.
    // FCM is only an optional wake-up channel. A missing token or missing
    // Firebase credentials must never make an in-app notification fail.
    if (!tokens.length || !messaging) {
      const now = new Date();
      await db.collection('notification_outbox').updateOne(
        { _id: outbox._id },
        {
          $set: {
            status: 'IN_APP',
            attempts: attempt,
            sentAt: now,
            lastError: !tokens.length ? 'IN_APP_ONLY_NO_DEVICE_TOKEN' : 'IN_APP_ONLY_FCM_DISABLED',
            updatedAt: now,
          },
        },
      );
      await db.collection('notifications').updateOne(
        { dedupeKey: outbox.dedupeKey },
        {
          $set: {
            status: 'IN_APP',
            deliveredAt: now,
            sentAt: now,
            updatedAt: now,
          },
        },
      );
      return;
    }

    let success = 0;
    let lastError = null;

    for (const item of tokens) {
      try {
        const critical = Number(outbox.level) === 1;
        const channelId = critical
          ? 'imove_critical'
          : outbox.type === 'BOOKING_OFFER'
              ? 'imove_trip_offers'
              : 'imove_general';

        await messaging.send({
          token: item.token,
          notification: {
            title: outbox.title,
            body: outbox.body,
          },
          data: {
            ...outbox.data,
            notificationId: String(outbox._id),
            type: outbox.type,
          },
          android: {
            priority: 'high',
            notification: {
              channelId,
              sound: 'default',
              defaultVibrateTimings: true,
              visibility: 'public',
            },
          },
          apns: {
            headers: { 'apns-priority': '10' },
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
                'content-available': 1,
              },
            },
          },
        });

        success += 1;
      } catch (error) {
        lastError = error.message;
        const code = String(error.code || '');
        if (
          code.includes('registration-token-not-registered') ||
          code.includes('invalid-registration-token')
        ) {
          await db.collection('device_tokens').updateOne(
            { _id: item._id },
            {
              $set: {
                enabled: false,
                invalidReason: code,
                updatedAt: new Date(),
              },
            },
          );
        }
      }
    }

    const now = new Date();
    if (success > 0) {
      await db.collection('notification_outbox').updateOne(
        { _id: outbox._id },
        {
          $set: {
            status: 'SENT',
            attempts: attempt,
            sentAt: now,
            lastError,
            updatedAt: now,
          },
        },
      );
      await db.collection('notifications').updateOne(
        { dedupeKey: outbox.dedupeKey },
        {
          $set: {
            status: 'SENT',
            sentAt: now,
            updatedAt: now,
          },
        },
      );
    } else {
      const final = attempt >= maxAttempts;
      await db.collection('notification_outbox').updateOne(
        { _id: outbox._id },
        {
          $set: {
            status: final ? 'FAILED' : 'RETRY',
            attempts: attempt,
            nextAttemptAt: new Date(Date.now() + retryDelay(attempt)),
            lastError: lastError || 'FCM_SEND_FAILED',
            updatedAt: now,
          },
        },
      );
    }
  }

  async function sweep() {
    const db = getDb();
    if (!db) return;
    const now = new Date();

    await db.collection('notification_outbox').updateMany(
      {
        status: 'PROCESSING',
        updatedAt: { $lte: new Date(now.getTime() - 60000) },
      },
      {
        $set: {
          status: 'RETRY',
          nextAttemptAt: now,
          lastError: 'WORKER_RECOVERY',
          updatedAt: now,
        },
      },
    );

    const batch = await db.collection('notification_outbox').find({
      status: { $in: ['PENDING', 'RETRY'] },
      nextAttemptAt: { $lte: now },
    }).sort({ createdAt: 1 }).limit(25).toArray();

    for (const item of batch) {
      const claimed = await db.collection('notification_outbox')
        .findOneAndUpdate(
          {
            _id: item._id,
            status: { $in: ['PENDING', 'RETRY'] },
          },
          {
            $set: {
              status: 'PROCESSING',
              updatedAt: new Date(),
            },
          },
          { returnDocument: 'after' },
        );

      const doc = claimed?._id ? claimed : claimed?.value;
      if (doc) {
        await processOne(doc).catch(async (error) => {
          await db.collection('notification_outbox').updateOne(
            { _id: item._id },
            {
              $set: {
                status: 'RETRY',
                lastError: error.message,
                nextAttemptAt: new Date(Date.now() + 5000),
                updatedAt: new Date(),
              },
            },
          );
        });
      }
    }
  }

  function recipientFilter(targetId) {
    return {
      $or: [
        { targetId },
        { userId: targetId },
      ],
    };
  }

  async function listNotifications(targetId, limit = 50) {
    return getDb().collection('notifications')
      .find(recipientFilter(targetId))
      .sort({ createdAt: -1 })
      .limit(Math.max(1, Math.min(100, Number(limit) || 50)))
      .toArray();
  }

  async function listPendingCritical(targetId, limit = 10) {
    const now = new Date();
    return getDb().collection('notifications')
      .find({
        $and: [
          recipientFilter(targetId),
          {
            level: 1,
            acknowledgedAt: null,
            $or: [
              { expiresAt: null },
              { expiresAt: { $exists: false } },
              { expiresAt: { $gt: now } },
            ],
          },
        ],
      })
      .sort({ createdAt: 1 })
      .limit(Math.max(1, Math.min(20, Number(limit) || 10)))
      .toArray();
  }

  async function markRead(targetId, notificationId) {
    const id = oid(notificationId);
    if (!id) return false;

    const result = await getDb().collection('notifications').updateOne(
      { $and: [{ _id: id }, recipientFilter(targetId)] },
      { $set: { readAt: new Date(), updatedAt: new Date() } },
    );

    return result.matchedCount > 0;
  }

  async function acknowledge(targetId, notificationId) {
    const id = oid(notificationId);
    if (!id) return false;

    const now = new Date();
    const result = await getDb().collection('notifications').updateOne(
      { $and: [{ _id: id }, recipientFilter(targetId)] },
      {
        $set: {
          readAt: now,
          acknowledgedAt: now,
          updatedAt: now,
        },
      },
    );

    return result.matchedCount > 0;
  }

  async function deleteNotification(targetId, notificationId) {
    const id = oid(notificationId);
    if (!id) return false;
    const db = getDb();
    const doc = await db.collection('notifications').findOne({
      $and: [{ _id: id }, recipientFilter(targetId)],
    });
    if (!doc) return false;
    const result = await db.collection('notifications').deleteOne({ _id: id });
    if (doc.broadcastId) {
      await db.collection('notification_outbox').deleteMany({
        broadcastId: doc.broadcastId,
        targetId: doc.targetId || targetId,
      });
    }
    return result.deletedCount > 0;
  }

  async function deleteAllNotifications(targetId) {
    const db = getDb();
    const rows = await db.collection('notifications')
      .find(recipientFilter(targetId))
      .project({ _id: 1, broadcastId: 1, targetId: 1 })
      .toArray();
    if (!rows.length) return 0;
    const ids = rows.map((x) => x._id);
    const result = await db.collection('notifications').deleteMany({ _id: { $in: ids } });
    const pairs = rows.filter((x) => x.broadcastId).map((x) => ({
      broadcastId: x.broadcastId,
      targetId: x.targetId || targetId,
    }));
    for (const pair of pairs) {
      await db.collection('notification_outbox').deleteMany(pair);
    }
    return result.deletedCount || 0;
  }

  async function retryNotification(id) {
    const _id = oid(id);
    if (!_id) throw new Error('Notification id không hợp lệ.');

    await getDb().collection('notification_outbox').updateOne(
      { _id },
      {
        $set: {
          status: 'RETRY',
          nextAttemptAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );

    return { ok: true };
  }

  async function start() {
    if (started) return;
    started = true;
    await initFirebase();
    worker = setInterval(
      () => sweep().catch((e) =>
        console.error('[V7.1 FCM Worker]', e.message),
      ),
      1200,
    );
    worker.unref?.();
  }

  function close() {
    if (worker) clearInterval(worker);
    worker = null;
  }

  return {
    start,
    close,
    databaseReady,
    isConfigured,
    registerDevice,
    disableDevice,
    enqueue,
    listNotifications,
    listPendingCritical,
    markRead,
    acknowledge,
    deleteNotification,
    deleteAllNotifications,
    retryNotification,
    sweep,
  };
}

module.exports = { createNotificationService, normalizeNotificationLevel };
