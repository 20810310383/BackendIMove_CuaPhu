require('dotenv').config();
const { MongoClient } = require('mongodb');
(async()=>{
  const client=new MongoClient(process.env.MONGODB_URI); await client.connect(); const db=client.db(process.env.MONGODB_DB||'th79_imove');
  const now=new Date();
  const value={maintenanceMode:false,maintenanceMessage:'TH79 iMove đang bảo trì. Vui lòng thử lại sau.',minUserVersion:'1.4.0',minDriverVersion:'1.4.0',latestUserVersion:'1.4.0',latestDriverVersion:'1.4.0',forceUpdateEnabled:true,securityMode:'PRODUCTION',securityPolicyVersion:2,driverRequirements:{gpsFreshSeconds:60,heartbeatFreshSeconds:60},securityPolicy:{enforceKyc:true,enforceRiskRestriction:true,requireFcm:true,requireTrustedDevice:true,requireIntegrity:true,requireFace:true,requireBiometric:true}};
  await db.collection('app_settings').updateOne({key:'V73_PRODUCTION_CONFIG'},{$setOnInsert:{key:'V73_PRODUCTION_CONFIG',value,status:'ACTIVE',createdAt:now},$set:{updatedAt:now}},{upsert:true});
  await db.collection('platform_ledger_entries').createIndex({reference:1},{unique:true,name:'uq_v73_ledger_reference'});
  await db.collection('platform_ledger_entries').createIndex({bookingId:1,createdAt:-1},{name:'idx_v73_ledger_booking'});
  console.log('V1.4.0 production config/indexes ready.'); await client.close();
})().catch(e=>{console.error(e);process.exit(1)});
