require('dotenv').config();
const { MongoClient } = require('mongodb');
const { createNotificationService } = require('../src/notification_service');

(async () => {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'th79_imove');

  const service = createNotificationService({ getDb: () => db });
  await service.databaseReady();

  await db.collection('admin_roles').updateMany(
    { code: { $in: ['OPERATIONS', 'OPERATOR', 'DISPATCHER'] }, status: 'ACTIVE' },
    {
      $addToSet: {
        permissions: {
          $each: ['broadcast.view', 'broadcast.send'],
        },
      },
      $set: { updatedAt: new Date() },
    },
  ).catch(() => {});

  console.log('[V7.1] Broadcast indexes/permissions ready');
  await client.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
