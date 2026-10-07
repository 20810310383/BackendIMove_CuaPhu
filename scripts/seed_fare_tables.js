require('dotenv').config();
const { MongoClient } = require('mongodb');

const SERVICE_DEFAULTS = {
  BIKE: {
    baseFare: 12000, baseDistanceKm: 2, minimumFare: 15000, pricePerMinute: 250,
    bookingFee: 2000, customerServiceFee: 1000, commission: 20,
    tiers: [{fromKm:0,toKm:2,pricePerKm:0},{fromKm:2,toKm:10,pricePerKm:4500},{fromKm:10,toKm:null,pricePerKm:4000}],
  },
  DELIVERY: {
    baseFare: 15000, baseDistanceKm: 2, minimumFare: 18000, pricePerMinute: 180,
    bookingFee: 2000, customerServiceFee: 1000, commission: 18,
    tiers: [{fromKm:0,toKm:2,pricePerKm:0},{fromKm:2,toKm:10,pricePerKm:5000},{fromKm:10,toKm:null,pricePerKm:4500}],
  },
  ERRAND: {
    baseFare: 18000, baseDistanceKm: 2, minimumFare: 22000, pricePerMinute: 300,
    bookingFee: 3000, customerServiceFee: 2000, commission: 18,
    tiers: [{fromKm:0,toKm:2,pricePerKm:0},{fromKm:2,toKm:10,pricePerKm:5500},{fromKm:10,toKm:null,pricePerKm:5000}],
  },
  FOOD: {
    baseFare: 12000, baseDistanceKm: 2, minimumFare: 15000, pricePerMinute: 150,
    bookingFee: 1500, customerServiceFee: 1000, commission: 15,
    tiers: [{fromKm:0,toKm:2,pricePerKm:0},{fromKm:2,toKm:8,pricePerKm:4500},{fromKm:8,toKm:null,pricePerKm:4000}],
  },
};

async function ensureService(db, serviceCode, cfg, now) {
  const activeFare = await db.collection('fare_configs').findOne(
    { serviceCode, areaCode: 'GLOBAL', status: 'ACTIVE' },
    { sort: { version: -1 } },
  );
  if (!activeFare) {
    await db.collection('fare_configs').updateOne(
      { serviceCode, areaCode: 'GLOBAL', version: 1 },
      { $set: {
        serviceCode, areaCode: 'GLOBAL', version: 1, status: 'ACTIVE', currency: 'VND',
        baseFare: cfg.baseFare, baseDistanceKm: cfg.baseDistanceKm, minimumFare: cfg.minimumFare,
        pricePerMinute: cfg.pricePerMinute, roundingUnit: 1000, distanceTiers: cfg.tiers,
        effectiveFrom: new Date('2026-09-01T00:00:00+07:00'), effectiveTo: null,
        note: `TH79 iMove ${serviceCode} global v1 - giá mẫu, cần cấu hình lại trước production`,
        updatedAt: now,
      }, $setOnInsert: { createdAt: now, createdBy: null, approvedBy: null } },
      { upsert: true },
    );
    console.log(`+ fare_configs ${serviceCode}/GLOBAL v1 ACTIVE`);
  } else console.log(`= ${serviceCode}: đã có fare ACTIVE v${activeFare.version}; không ghi đè.`);

  const activeFees = await db.collection('platform_fees').findOne(
    { serviceCode, areaCode: 'GLOBAL', status: 'ACTIVE' },
    { sort: { version: -1 } },
  );
  if (!activeFees) {
    await db.collection('platform_fees').updateOne(
      { serviceCode, areaCode: 'GLOBAL', version: 1 },
      { $set: {
        serviceCode, areaCode: 'GLOBAL', version: 1, status: 'ACTIVE',
        bookingFee: cfg.bookingFee, customerServiceFee: cfg.customerServiceFee,
        driverFixedFee: 0, paymentFeePercent: 0,
        driverCommission: { type: 'PERCENT', value: cfg.commission },
        effectiveFrom: new Date('2026-09-01T00:00:00+07:00'), effectiveTo: null, updatedAt: now,
      }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    console.log(`+ platform_fees ${serviceCode}/GLOBAL v1 ACTIVE`);
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'th79_imove';
  if (!uri) throw new Error('Thiếu MONGODB_URI trong .env');
  const client = new MongoClient(uri); await client.connect();
  const db = client.db(dbName); const now = new Date();

  for (const [code, cfg] of Object.entries(SERVICE_DEFAULTS)) await ensureService(db, code, cfg, now);

  await db.collection('app_settings').updateOne(
    { key: 'COMMERCE_DISPATCH_CONFIG' },
    { $setOnInsert: {
      key: 'COMMERCE_DISPATCH_CONFIG', status: 'ACTIVE',
      value: { initialSearchRadiusKm:3, maxSearchRadiusKm:12, radiusExpansionStepKm:2, driverAcceptSeconds:20, offersPerBatch:5 },
      description:'Cấu hình điều phối DELIVERY / ERRAND / FOOD', createdAt:now, updatedAt:now,
    } }, { upsert:true },
  );
  await db.collection('fare_configs').createIndex({serviceCode:1,areaCode:1,version:-1},{unique:true,name:'uq_fare_version'});
  await db.collection('platform_fees').createIndex({serviceCode:1,areaCode:1,version:-1},{unique:true,name:'uq_platform_fee_version'});
  console.log('==========================================');
  console.log('TH79 iMove 1.6.0 - BIKE / DELIVERY / ERRAND / FOOD FARE READY');
  console.log('LƯU Ý: các mức trên là dữ liệu seed để test, không phải bảng giá thương mại đã phê duyệt.');
  console.log('==========================================');
  await client.close();
}
main().catch((error)=>{console.error('SEED FARE FAILED:',error);process.exit(1);});
