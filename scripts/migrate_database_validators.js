require('dotenv').config();
const { MongoClient } = require('mongodb');
const { repairDatabase } = require('../src/database_repair');

const uri = String(process.env.MONGODB_URI || '').trim();
const dbName = String(process.env.MONGODB_DB || 'th79_imove').trim();
if (!uri) {
  console.error('[FAILED] Thiếu MONGODB_URI trong .env');
  process.exit(1);
}

(async () => {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    await db.command({ ping: 1 });
    console.log(`MongoDB connected -> ${dbName}`);
    await repairDatabase({ db, client, logger: console });
    console.log('\n[1.4.0] DATABASE REPAIR PASS');
  } catch (error) {
    console.error('\n[1.4.0] DATABASE REPAIR FAILED');
    console.error(error?.message || error);
    if (error?.codeName === 'Unauthorized') {
      console.error('MongoDB user cần quyền collMod/bypassDocumentValidation để tự sửa validator.');
    }
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})();
