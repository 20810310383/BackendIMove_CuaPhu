require('dotenv').config();
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'th79_imove';
if (!uri) throw new Error('Thiếu MONGODB_URI trong .env');

(async () => {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const now = new Date();
  const week = 7 * 86400000;

  const incentives = [
    {
      code: 'PEAK_LUNCH', title: 'Thưởng giờ cao điểm',
      description: 'Hoàn thành đủ số chuyến trong khung giờ cao điểm để nhận thưởng.',
      rewardAmount: 90000, rewardPoints: 90, targetTrips: 9,
      serviceCode: 'ALL', zoneCode: null, priority: 100,
      startsAt: now, endsAt: new Date(now.getTime() + week), status: 'ACTIVE',
    },
    {
      code: 'STREAK_5', title: 'Chuỗi 5 cuốc liên tiếp',
      description: 'Hoàn thành 5 cuốc liên tiếp, không hủy giữa chuỗi.',
      rewardAmount: 70000, rewardPoints: 70, targetTrips: 5,
      serviceCode: 'ALL', zoneCode: null, priority: 90,
      startsAt: now, endsAt: new Date(now.getTime() + week), status: 'ACTIVE',
    },
  ];
  for (const row of incentives) {
    await db.collection('driver_incentives').updateOne(
      { code: row.code },
      { $set: { ...row, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
  }

  const zones = [
    { code: 'HCM_Q1', name: 'Quận 1', demandLevel: 'VERY_HIGH', demandPercent: 18, incomeBoostPercent: 22, center: { lat: 10.7769, lng: 106.7009 }, radiusKm: 3, priority: 100, status: 'ACTIVE' },
    { code: 'HCM_BINH_THANH', name: 'Bình Thạnh', demandLevel: 'HIGH', demandPercent: 12, incomeBoostPercent: 12, center: { lat: 10.8106, lng: 106.7091 }, radiusKm: 3, priority: 80, status: 'ACTIVE' },
    { code: 'HCM_TAN_BINH', name: 'Tân Bình', demandLevel: 'NORMAL', demandPercent: 5, incomeBoostPercent: 5, center: { lat: 10.8015, lng: 106.6526 }, radiusKm: 4, priority: 60, status: 'ACTIVE' },
  ];
  for (const row of zones) {
    await db.collection('demand_zones').updateOne(
      { code: row.code },
      { $set: { ...row, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
  }

  await Promise.all([
    db.collection('driver_reward_accounts').createIndex({ driverId: 1 }, { unique: true, name: 'uq_driver_reward_account' }),
    db.collection('driver_reward_transactions').createIndex({ sourceTransactionId: 1 }, { unique: true, sparse: true, name: 'uq_driver_reward_source_tx' }),
    db.collection('driver_incentives').createIndex({ code: 1 }, { unique: true, name: 'uq_driver_incentive_code' }),
    db.collection('demand_zones').createIndex({ code: 1 }, { unique: true, name: 'uq_demand_zone_code' }),
  ]);

  console.log('[V7.2] Driver Experience seed complete');
  console.log('Incentives:', await db.collection('driver_incentives').countDocuments({ status: 'ACTIVE' }));
  console.log('Demand zones:', await db.collection('demand_zones').countDocuments({ status: 'ACTIVE' }));
  await client.close();
})().catch((error) => { console.error(error); process.exit(1); });
