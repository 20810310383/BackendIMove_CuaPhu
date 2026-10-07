require('dotenv').config();
const { MongoClient } = require('mongodb');
const { DEFAULT_MATCHING_POLICY } = require('../src/matching_policy');

(async()=>{
  const uri=String(process.env.MONGODB_URI||'').trim();
  const dbName=String(process.env.MONGODB_DB||'th79_imove').trim();
  if(!uri) throw new Error('Thiếu MONGODB_URI trong .env');
  const client=new MongoClient(uri);
  await client.connect();
  const db=client.db(dbName);
  const now=new Date();
  const result=await db.collection('matching_policies').updateOne(
    {key:'BIKE_MATCHING_POLICY'},
    {$setOnInsert:{...DEFAULT_MATCHING_POLICY,createdAt:now,updatedAt:now}},
    {upsert:true},
  );
  await db.collection('matching_policies').createIndex({key:1},{unique:true,name:'uq_matching_policy_key'});
  console.log(result.upsertedCount?'[V6.8] Đã tạo policy mặc định.':'[V6.8] Policy đã tồn tại, giữ nguyên cấu hình Admin.');
  await client.close();
})().catch((e)=>{console.error('[V6.8 seed matching] FAILED:',e.message);process.exit(1)});
