require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('Thiếu MONGODB_URI trong Backend/.env');
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'th79_imove');

  const latest = await db.collection('admin_broadcasts')
    .find({})
    .sort({ createdAt: -1 })
    .limit(5)
    .toArray();

  console.log('\n=== iMove notification verification ===');
  for (const item of latest) {
    const [outbox, notifications] = await Promise.all([
      db.collection('notification_outbox').countDocuments({ broadcastId: item._id }),
      db.collection('notifications').countDocuments({ broadcastId: item._id }),
    ]);
    console.log({
      broadcastId: String(item._id),
      title: item.title,
      level: item.level,
      targets: item.totalTargets,
      outbox,
      notifications,
    });
  }

  const latestNotifications = await db.collection('notifications')
    .find({ type: 'ADMIN_BROADCAST' })
    .sort({ createdAt: -1 })
    .limit(10)
    .project({ targetType: 1, targetId: 1, userId: 1, title: 1, level: 1, status: 1, createdAt: 1 })
    .toArray();

  console.log('\nLatest ADMIN_BROADCAST notifications:');
  for (const row of latestNotifications) {
    console.log({
      id: String(row._id),
      targetType: row.targetType,
      targetId: row.targetId ? String(row.targetId) : null,
      userId: row.userId ? String(row.userId) : null,
      title: row.title,
      level: row.level,
      status: row.status,
      createdAt: row.createdAt,
    });
  }

  await client.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
