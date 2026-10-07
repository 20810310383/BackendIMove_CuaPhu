require('dotenv').config();
const { MongoClient } = require('mongodb');
function n(v){const x=Number(v);return Number.isFinite(x)?x:0}
(async()=>{
  const client=new MongoClient(process.env.MONGODB_URI); await client.connect(); const db=client.db(process.env.MONGODB_DB||'th79_imove');
  const bookings=await db.collection('bookings').find({status:'COMPLETED'}).toArray();
  let missingSnapshot=0,missingLedger=0,earningMismatch=0;
  for(const b of bookings){
    if(!b.fareSnapshot) missingSnapshot++;
    const ledger=await db.collection('platform_ledger_entries').countDocuments({bookingId:b._id});
    if(ledger<3) missingLedger++;
    const expected=Math.round(n(b.fareSnapshot?.driverNetAmount||b.pricing?.driverNetAmount));
    const wallet=await db.collection('wallet_transactions').findOne({bookingId:b._id,type:'DRIVER_TRIP_EARNING',status:'COMPLETED'});
    if(expected>0 && Math.round(n(wallet?.amount))!==expected) earningMismatch++;
  }
  console.log(JSON.stringify({completedBookings:bookings.length,missingFareSnapshot:missingSnapshot,missingPlatformLedger:missingLedger,driverEarningMismatch:earningMismatch,ok:missingSnapshot===0&&missingLedger===0&&earningMismatch===0},null,2));
  await client.close(); if(missingSnapshot||missingLedger||earningMismatch)process.exitCode=2;
})().catch(e=>{console.error(e);process.exit(1)});
