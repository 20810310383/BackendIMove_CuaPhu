require('dotenv').config();
const { MongoClient } = require('mongodb');
(async()=>{
 const uri=String(process.env.MONGODB_URI||''); if(!uri)throw new Error('Thiếu MONGODB_URI');
 const client=new MongoClient(uri); await client.connect(); const db=client.db(process.env.MONGODB_DB||'th79_imove');
 const ping=(await db.command({ping:1})).ok===1;
 const cfg=await db.collection('app_settings').findOne({key:'V73_PRODUCTION_CONFIG'});
 const dupLedger=await db.collection('platform_ledger_entries').aggregate([{$group:{_id:'$reference',n:{$sum:1}}},{$match:{n:{$gt:1}}},{$limit:1}]).toArray();
 const duplicateWallet=await db.collection('wallet_transactions').aggregate([{$match:{type:'DRIVER_TRIP_EARNING',status:'COMPLETED'}},{$group:{_id:'$bookingId',n:{$sum:1}}},{$match:{n:{$gt:1}}},{$limit:1}]).toArray();
 const staleSettlement=await db.collection('bookings').countDocuments({status:'COMPLETED',$or:[{'settlementV73.status':{$ne:'POSTED'}},{settlementV73:{$exists:false}}]});
 const result={mongo:ping,productionConfig:Boolean(cfg),duplicateLedger:dupLedger.length,duplicateDriverEarning:duplicateWallet.length,unpostedCompletedBookings:staleSettlement};
 result.ok=result.mongo&&result.productionConfig&&result.duplicateLedger===0&&result.duplicateDriverEarning===0;
 console.log('=====================================');console.log(' TH79 iMove V7.3 Production Verify');console.log('=====================================');
 for(const [k,v] of Object.entries(result))console.log(`${k.padEnd(30)} ${v}`);
 console.log('RESULT'.padEnd(30),result.ok?'READY':'CHECK REQUIRED');
 await client.close(); if(!result.ok)process.exitCode=2;
})().catch(e=>{console.error(e);process.exit(1)});
