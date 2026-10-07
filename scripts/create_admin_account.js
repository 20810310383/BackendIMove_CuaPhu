const path = require('path');
const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const fullName = String(process.env.ADMIN_ACCOUNT_NAME || '').trim();
const email = String(process.env.ADMIN_ACCOUNT_EMAIL || '').trim().toLowerCase();
const phone = String(process.env.ADMIN_ACCOUNT_PHONE || '').trim();
const password = String(process.env.ADMIN_ACCOUNT_PASSWORD || '');
const mongoUri = String(process.env.MONGODB_URI || '').trim();
const databaseName = String(process.env.MONGODB_DB || 'th79_imove').trim();

if (!fullName || !email || !phone || password.length < 12) {
  throw new Error('Cần ADMIN_ACCOUNT_NAME, ADMIN_ACCOUNT_EMAIL, ADMIN_ACCOUNT_PHONE và ADMIN_ACCOUNT_PASSWORD (ít nhất 12 ký tự).');
}
if (!mongoUri || mongoUri.includes('YOUR_CLUSTER')) {
  throw new Error('MONGODB_URI chưa được cấu hình hợp lệ trong BackendImove/.env.');
}

(async () => {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const db = client.db(databaseName);
    const users = db.collection('users');
    const duplicate = await users.findOne({ $or: [{ email }, { phone }] }, { projection: { _id: 1 } });
    if (duplicate) throw new Error('Email hoặc số điện thoại đã tồn tại; không ghi đè tài khoản hiện có.');

    const now = new Date();
    const result = await users.insertOne({
      fullName,
      email,
      phone,
      passwordHash: await bcrypt.hash(password, 12),
      roles: ['ADMIN'],
      adminRoleCodes: ['SUPER_ADMIN'],
      roleCodes: ['SUPER_ADMIN'],
      status: 'ACTIVE',
      mustChangePassword: true,
      failedLoginCount: 0,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });

    console.log(JSON.stringify({
      created: true,
      id: String(result.insertedId),
      login: email,
      database: databaseName,
    }));
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
