require('dotenv').config();

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const SEED_KEY = 'TH79_TEST_MERCHANTS_12_V1';
const DEFAULT_PASSWORD = String(
  process.env.TEST_MERCHANT_PASSWORD || 'Merchant@Test174',
);

const merchants = [
  {
    code: 'TH79-TEST-REST-01',
    phone: '0909000101',
    name: 'Bếp Việt 79',
    merchantType: 'RESTAURANT',
    categoryName: 'Cơm Việt',
    address: 'Quận Gò Vấp, TP. Hồ Chí Minh',
    coordinates: [106.6788, 10.8386],
    rating: 4.9,
    commissionRate: 15,
    openingHours: '06:30-22:00',
    products: [
      ['Cơm gà xối mỡ', 'Món chính', 59000],
      ['Cơm sườn bì chả', 'Món chính', 65000],
      ['Canh chua cá', 'Món thêm', 35000],
      ['Trà tắc', 'Đồ uống', 18000],
      ['Sữa đậu nành', 'Đồ uống', 15000],
    ],
  },
  {
    code: 'TH79-TEST-REST-02',
    phone: '0909000102',
    name: 'Phở Sài Gòn 79',
    merchantType: 'RESTAURANT',
    categoryName: 'Phở & Bún',
    address: 'Quận Tân Bình, TP. Hồ Chí Minh',
    coordinates: [106.6523, 10.8017],
    rating: 4.8,
    commissionRate: 15,
    openingHours: '06:00-21:30',
    products: [
      ['Phở bò tái', 'Phở', 65000],
      ['Phở bò đặc biệt', 'Phở', 79000],
      ['Bún bò Huế', 'Bún', 69000],
      ['Quẩy', 'Món thêm', 10000],
      ['Nước sâm', 'Đồ uống', 20000],
    ],
  },
  {
    code: 'TH79-TEST-REST-03',
    phone: '0909000103',
    name: 'Cơm Tấm Minh Anh',
    merchantType: 'RESTAURANT',
    categoryName: 'Cơm tấm',
    address: 'Quận Phú Nhuận, TP. Hồ Chí Minh',
    coordinates: [106.6803, 10.7992],
    rating: 4.7,
    commissionRate: 14,
    openingHours: '07:00-22:00',
    products: [
      ['Cơm tấm sườn', 'Cơm tấm', 55000],
      ['Cơm tấm sườn bì', 'Cơm tấm', 62000],
      ['Cơm tấm sườn bì chả', 'Cơm tấm', 70000],
      ['Trứng ốp la', 'Món thêm', 12000],
      ['Trà đá', 'Đồ uống', 5000],
    ],
  },
  {
    code: 'TH79-TEST-REST-04',
    phone: '0909000104',
    name: 'Gà Rán TH79 Chicken',
    merchantType: 'RESTAURANT',
    categoryName: 'Gà rán & Fast Food',
    address: 'Quận Bình Thạnh, TP. Hồ Chí Minh',
    coordinates: [106.7104, 10.8106],
    rating: 4.8,
    commissionRate: 16,
    openingHours: '09:00-23:00',
    products: [
      ['Combo gà rán 2 miếng', 'Combo', 79000],
      ['Gà sốt cay Hàn Quốc', 'Gà rán', 89000],
      ['Khoai tây chiên', 'Món thêm', 32000],
      ['Burger gà', 'Burger', 49000],
      ['Pepsi', 'Đồ uống', 18000],
    ],
  },
  {
    code: 'TH79-TEST-REST-05',
    phone: '0909000105',
    name: 'Bún Đậu Mẹt 79',
    merchantType: 'RESTAURANT',
    categoryName: 'Bún đậu',
    address: 'Quận 3, TP. Hồ Chí Minh',
    coordinates: [106.6871, 10.7847],
    rating: 4.6,
    commissionRate: 14,
    openingHours: '10:00-22:00',
    products: [
      ['Mẹt bún đậu tiêu chuẩn', 'Bún đậu', 65000],
      ['Mẹt bún đậu đặc biệt', 'Bún đậu', 95000],
      ['Nem chua rán', 'Món thêm', 39000],
      ['Chả cốm', 'Món thêm', 35000],
      ['Trà chanh', 'Đồ uống', 20000],
    ],
  },
  {
    code: 'TH79-TEST-REST-06',
    phone: '0909000106',
    name: 'Coffee & Tea iMOVE',
    merchantType: 'RESTAURANT',
    categoryName: 'Cà phê & Trà sữa',
    address: 'Quận 1, TP. Hồ Chí Minh',
    coordinates: [106.7009, 10.7769],
    rating: 4.9,
    commissionRate: 17,
    openingHours: '07:00-23:00',
    products: [
      ['Cà phê sữa đá', 'Cà phê', 29000],
      ['Bạc xỉu', 'Cà phê', 35000],
      ['Trà đào cam sả', 'Trà', 45000],
      ['Trà sữa trân châu', 'Trà sữa', 49000],
      ['Croissant bơ', 'Bánh', 32000],
    ],
  },
  {
    code: 'TH79-TEST-STORE-01',
    phone: '0909000107',
    name: 'TH79 Mart Gò Vấp',
    merchantType: 'STORE',
    categoryName: 'Siêu thị mini',
    address: 'Quận Gò Vấp, TP. Hồ Chí Minh',
    coordinates: [106.6689, 10.8317],
    rating: 4.8,
    commissionRate: 12,
    openingHours: '06:00-23:30',
    products: [
      ['Nước suối 500ml', 'Nước uống', 10000],
      ['Mì ly', 'Thực phẩm', 18000],
      ['Sữa tươi 1L', 'Sữa', 38000],
      ['Khăn giấy', 'Gia dụng', 25000],
      ['Bánh snack', 'Ăn vặt', 16000],
    ],
  },
  {
    code: 'TH79-TEST-STORE-02',
    phone: '0909000108',
    name: 'Cửa Hàng Tiện Lợi 79',
    merchantType: 'STORE',
    categoryName: 'Tiện lợi',
    address: 'Quận Tân Phú, TP. Hồ Chí Minh',
    coordinates: [106.6268, 10.7919],
    rating: 4.7,
    commissionRate: 12,
    openingHours: '24/7',
    products: [
      ['Nước ngọt lon', 'Nước uống', 15000],
      ['Xúc xích', 'Ăn nhanh', 18000],
      ['Bánh mì sandwich', 'Thực phẩm', 32000],
      ['Kem hộp', 'Đông lạnh', 45000],
      ['Pin AA 2 viên', 'Gia dụng', 35000],
    ],
  },
  {
    code: 'TH79-TEST-STORE-03',
    phone: '0909000109',
    name: 'Fresh Fruit 79',
    merchantType: 'STORE',
    categoryName: 'Trái cây',
    address: 'Quận 10, TP. Hồ Chí Minh',
    coordinates: [106.6672, 10.7725],
    rating: 4.9,
    commissionRate: 13,
    openingHours: '07:00-21:30',
    products: [
      ['Cam sành 1kg', 'Trái cây', 45000],
      ['Táo đỏ 1kg', 'Trái cây', 79000],
      ['Nho xanh 500g', 'Trái cây', 95000],
      ['Dưa hấu 1 trái', 'Trái cây', 65000],
      ['Combo trái cây cắt sẵn', 'Combo', 55000],
    ],
  },
  {
    code: 'TH79-TEST-STORE-04',
    phone: '0909000110',
    name: 'Hoa Tươi iMOVE',
    merchantType: 'STORE',
    categoryName: 'Hoa & Quà tặng',
    address: 'Quận 7, TP. Hồ Chí Minh',
    coordinates: [106.7219, 10.7298],
    rating: 4.8,
    commissionRate: 13,
    openingHours: '08:00-21:00',
    products: [
      ['Bó hoa hồng đỏ', 'Hoa tươi', 250000],
      ['Bó hướng dương', 'Hoa tươi', 220000],
      ['Giỏ hoa chúc mừng', 'Giỏ hoa', 450000],
      ['Thiệp chúc mừng', 'Phụ kiện', 25000],
      ['Gấu bông mini', 'Quà tặng', 89000],
    ],
  },
  {
    code: 'TH79-TEST-STORE-05',
    phone: '0909000111',
    name: 'Mẹ & Bé TH79',
    merchantType: 'STORE',
    categoryName: 'Mẹ & Bé',
    address: 'TP. Thủ Đức, TP. Hồ Chí Minh',
    coordinates: [106.7597, 10.8494],
    rating: 4.7,
    commissionRate: 12,
    openingHours: '08:00-22:00',
    products: [
      ['Khăn ướt em bé', 'Chăm sóc bé', 35000],
      ['Tã quần size M', 'Tã bỉm', 185000],
      ['Sữa tắm em bé', 'Chăm sóc bé', 89000],
      ['Bình sữa 240ml', 'Đồ dùng bé', 125000],
      ['Bột ăn dặm', 'Dinh dưỡng', 95000],
    ],
  },
  {
    code: 'TH79-TEST-STORE-06',
    phone: '0909000112',
    name: 'Pet Shop 79',
    merchantType: 'STORE',
    categoryName: 'Thú cưng',
    address: 'Quận Bình Tân, TP. Hồ Chí Minh',
    coordinates: [106.6062, 10.7658],
    rating: 4.6,
    commissionRate: 12,
    openingHours: '08:00-21:30',
    products: [
      ['Hạt cho mèo 1kg', 'Thức ăn mèo', 135000],
      ['Hạt cho chó 1kg', 'Thức ăn chó', 145000],
      ['Cát vệ sinh 5L', 'Vệ sinh', 85000],
      ['Dây dắt thú cưng', 'Phụ kiện', 75000],
      ['Snack thưởng thú cưng', 'Đồ ăn vặt', 55000],
    ],
  },
];

function emailFor(phone) {
  return `merchant.${phone}@test.th79.local`;
}

async function ensureTestUser(db, merchant, passwordHash, now) {
  const existing = await db.collection('users').findOne({ phone: merchant.phone });

  if (existing && existing.testSeedKey !== SEED_KEY) {
    throw new Error(
      `SĐT ${merchant.phone} đã tồn tại và không phải tài khoản seed ${SEED_KEY}. ` +
      'Dừng để tránh ghi đè tài khoản thật.',
    );
  }

  const fullName = `Quản lý ${merchant.name}`;
  const email = emailFor(merchant.phone);

  await db.collection('users').updateOne(
    { phone: merchant.phone },
    {
      $set: {
        phone: merchant.phone,
        fullName,
        email,
        passwordHash,
        status: 'ACTIVE',
        testSeedKey: SEED_KEY,
        updatedAt: now,
      },
      $addToSet: { roles: 'MERCHANT' },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  return db.collection('users').findOne({ phone: merchant.phone });
}

async function ensureMerchant(db, spec, now) {
  const existing = await db.collection('merchants').findOne({ code: spec.code });

  if (existing && existing.testSeedKey !== SEED_KEY) {
    throw new Error(
      `Merchant code ${spec.code} đã tồn tại và không phải dữ liệu seed. ` +
      'Dừng để tránh ghi đè dữ liệu thật.',
    );
  }

  const categoryCode = spec.merchantType === 'RESTAURANT' ? 'FOOD' : 'ERRAND';
  const merchantTypeLabel = spec.merchantType === 'RESTAURANT'
    ? 'Nhà hàng · Food'
    : 'Cửa hàng · Đặt hộ';

  await db.collection('merchants').updateOne(
    { code: spec.code },
    {
      $set: {
        code: spec.code,
        name: spec.name,
        categoryCode,
        categoryName: spec.categoryName,
        merchantType: spec.merchantType,
        merchantTypeLabel,
        description: `${spec.name} - dữ liệu test TH79 iMove cho luồng ${categoryCode}.`,
        address: spec.address,
        location: {
          type: 'Point',
          coordinates: spec.coordinates,
        },
        phone: spec.phone,
        status: 'ACTIVE',
        rating: spec.rating,
        commissionRate: spec.commissionRate,
        openingHours: spec.openingHours,
        pickupInstruction: 'Tài xế báo mã đơn TH79 iMove tại quầy nhận hàng.',
        logoUrl: null,
        coverUrl: null,
        testSeedKey: SEED_KEY,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  return db.collection('merchants').findOne({ code: spec.code });
}

async function seedProducts(db, merchantDoc, spec, now) {
  await db.collection('products').deleteMany({
    merchantId: merchantDoc._id,
    testSeedKey: SEED_KEY,
  });

  const docs = spec.products.map(([name, categoryName, price], index) => ({
    merchantId: merchantDoc._id,
    name,
    description: `${name} - sản phẩm test của ${spec.name}.`,
    categoryName,
    price,
    imageUrl: null,
    status: 'ACTIVE',
    stockStatus: 'AVAILABLE',
    sortOrder: (index + 1) * 10,
    testSeedKey: SEED_KEY,
    createdAt: now,
    updatedAt: now,
  }));

  if (docs.length) {
    await db.collection('products').insertMany(docs);
  }

  return docs.length;
}

async function main() {
  const uri = String(process.env.MONGODB_URI || '').trim();
  const dbName = String(process.env.MONGODB_DB || 'th79_imove').trim();

  if (!uri) {
    throw new Error('Thiếu MONGODB_URI trong Backend/.env');
  }

  if (!DEFAULT_PASSWORD || DEFAULT_PASSWORD.length < 8) {
    throw new Error('TEST_MERCHANT_PASSWORD phải có ít nhất 8 ký tự.');
  }

  const client = new MongoClient(uri);
  await client.connect();

  try {
    const db = client.db(dbName);
    const now = new Date();
    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);

    let productTotal = 0;

    for (const spec of merchants) {
      const user = await ensureTestUser(db, spec, passwordHash, now);
      const merchant = await ensureMerchant(db, spec, now);

      await db.collection('merchant_users').updateOne(
        { userId: user._id },
        {
          $set: {
            userId: user._id,
            merchantId: merchant._id,
            role: 'OWNER',
            status: 'ACTIVE',
            testSeedKey: SEED_KEY,
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );

      productTotal += await seedProducts(db, merchant, spec, now);
    }

    await db.collection('merchants').createIndex(
      { code: 1 },
      { unique: true, sparse: true, name: 'uq_merchant_code' },
    );
    await db.collection('merchants').createIndex(
      { location: '2dsphere' },
      { sparse: true, name: 'geo_merchant_location' },
    );
    await db.collection('merchant_users').createIndex(
      { userId: 1 },
      { unique: true, name: 'uq_merchant_user' },
    );
    await db.collection('products').createIndex(
      { merchantId: 1, status: 1, categoryName: 1 },
      { name: 'idx_merchant_products' },
    );

    console.log('=====================================================');
    console.log('TH79 iMove - 12 Merchant Test Seed READY');
    console.log(`Database : ${dbName}`);
    console.log(`Merchants: ${merchants.length}`);
    console.log(`Products : ${productTotal}`);
    console.log(`Password : ${DEFAULT_PASSWORD}`);
    console.log('-----------------------------------------------------');
    for (const spec of merchants) {
      console.log(`${spec.phone} | ${spec.name} | ${spec.merchantType}`);
    }
    console.log('=====================================================');
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error('[SEED MERCHANT TEST ERROR]', error);
  process.exit(1);
});
