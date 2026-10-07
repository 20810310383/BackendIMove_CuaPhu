require('dotenv').config();
const { MongoClient } = require('mongodb');

const notificationSchema = {
  $jsonSchema: {
    bsonType: 'object',
    properties: {
      userId: { bsonType: ['objectId', 'null'] },
      targetId: { bsonType: ['objectId', 'null'] },
      targetType: { enum: ['CUSTOMER', 'DRIVER', 'ADMIN', null] },
      title: { bsonType: 'string' },
      body: { bsonType: 'string' },
      type: { bsonType: ['string', 'null'] },
      data: { bsonType: ['object', 'null'] },
      status: { bsonType: ['string', 'null'] },
      dedupeKey: { bsonType: ['string', 'null'] },
      bookingId: { bsonType: ['objectId', 'null'] },
      offerId: { bsonType: ['objectId', 'null'] },
      broadcastId: { bsonType: ['objectId', 'null'] },
      level: { bsonType: ['int', 'long', 'double', 'null'] },
      requireAck: { bsonType: ['bool', 'null'] },
      expiresAt: { bsonType: ['date', 'null'] },
      readAt: { bsonType: ['date', 'null'] },
      openedAt: { bsonType: ['date', 'null'] },
      deliveredAt: { bsonType: ['date', 'null'] },
      acknowledgedAt: { bsonType: ['date', 'null'] },
      createdAt: { bsonType: ['date', 'null'] },
      updatedAt: { bsonType: ['date', 'null'] },
    },
  },
};

const deviceTokenSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['userId', 'token', 'platform'],
    properties: {
      userId: { bsonType: 'objectId' },
      token: { bsonType: 'string' },
      platform: { enum: ['ANDROID', 'IOS', 'WEB', 'UNKNOWN'] },
      userType: { enum: ['CUSTOMER', 'DRIVER', 'ADMIN', null] },
      appType: { enum: ['USER', 'DRIVER', 'ADMIN', null] },
      deviceId: { bsonType: ['string', 'null'] },
      appVersion: { bsonType: ['string', 'null'] },
      enabled: { bsonType: ['bool', 'null'] },
      active: { bsonType: ['bool', 'null'] },
      lastSeenAt: { bsonType: ['date', 'null'] },
      createdAt: { bsonType: ['date', 'null'] },
      updatedAt: { bsonType: ['date', 'null'] },
    },
  },
};

(async () => {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'th79_imove');

  const names = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name),
  );

  for (const name of ['notifications', 'device_tokens', 'notification_outbox', 'admin_broadcasts']) {
    if (!names.has(name)) {
      await db.createCollection(name);
      names.add(name);
    }
  }

  await db.command({
    collMod: 'notifications',
    validator: notificationSchema,
    validationLevel: 'moderate',
    validationAction: 'error',
  });

  await db.command({
    collMod: 'device_tokens',
    validator: deviceTokenSchema,
    validationLevel: 'moderate',
    validationAction: 'error',
  });

  await Promise.all([
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
    db.collection('admin_broadcasts').createIndex(
      { createdAt: -1 },
      { name: 'idx_admin_broadcast_created' },
    ),
  ]);

  console.log('[V7.1] NOTIFICATION/BROADCAST VALIDATOR MIGRATION PASS');
  await client.close();
})().catch((error) => {
  console.error('[V7.1] migration failed:', error);
  process.exit(1);
});
