require('dotenv').config();
const { MongoClient } = require('mongodb');
const { DEFAULT_CONFIG } = require('../src/dispatch_engine');
(async()=>{const uri=String(process.env.MONGODB_URI||'');if(!uri)throw new Error('Thiếu MONGODB_URI');const client=new MongoClient(uri);await client.connect();const db=client.db(process.env.MONGODB_DB||'th79_imove');await db.collection('dispatch_configs').updateOne({key:DEFAULT_CONFIG.key},{$set:{...DEFAULT_CONFIG,updatedAt:new Date()},$setOnInsert:{createdAt:new Date()}},{upsert:true});console.log('[V6.9] Dispatch config seeded');await client.close();})().catch(e=>{console.error(e);process.exit(1);});
