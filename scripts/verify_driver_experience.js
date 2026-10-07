require('dotenv').config();
const { MongoClient } = require('mongodb');
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'th79_imove';
if (!uri) throw new Error('Thiếu MONGODB_URI trong .env');
(async () => {
  const client = new MongoClient(uri); await client.connect(); const db = client.db(dbName);
  const duplicateReward = await db.collection('driver_reward_transactions').aggregate([
    { $match: { sourceTransactionId: { $ne: null } } },
    { $group: { _id: '$sourceTransactionId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }, { $count: 'count' },
  ]).toArray();
  const negativePoints = await db.collection('driver_reward_accounts').countDocuments({ balance: { $lt: 0 } });
  const invalidZones = await db.collection('demand_zones').countDocuments({ status: 'ACTIVE', $or: [{ name: { $in: [null, ''] } }, { radiusKm: { $lte: 0 } }] });
  const badIncentives = await db.collection('driver_incentives').countDocuments({ status: 'ACTIVE', targetTrips: { $lte: 0 } });
  const report = {
    duplicateRewardSourceTransactions: duplicateReward[0]?.count || 0,
    negativeDriverPointAccounts: negativePoints,
    invalidActiveDemandZones: invalidZones,
    invalidActiveIncentives: badIncentives,
  };
  console.table(report);
  const fail = Object.values(report).some((x) => Number(x) > 0);
  console.log(fail ? '[V7.2] VERIFY FAIL' : '[V7.2] VERIFY PASS');
  await client.close(); process.exit(fail ? 2 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
