require('dotenv').config();
const { MongoClient } = require('mongodb');
async function main(){
  const uri=process.env.MONGODB_URI; if(!uri) throw new Error('Thiếu MONGODB_URI trong .env');
  const client=new MongoClient(uri); await client.connect();
  const db=client.db(process.env.MONGODB_DB||'th79_imove');
  const tasks=[
    ['merchants',{code:1},{unique:true,sparse:true,name:'uq_merchant_code'}],
    ['merchants',{location:'2dsphere'},{sparse:true,name:'geo_merchant_location'}],
    ['merchant_users',{userId:1},{unique:true,name:'uq_merchant_user'}],
    ['merchant_users',{merchantId:1,status:1},{name:'idx_merchant_members'}],
    ['products',{merchantId:1,status:1,categoryName:1},{name:'idx_merchant_products'}],
    ['orders',{orderCode:1},{unique:true,name:'uq_order_code'}],
    ['orders',{customerId:1,createdAt:-1},{name:'idx_customer_orders'}],
    ['orders',{merchantId:1,status:1,createdAt:-1},{name:'idx_merchant_orders'}],
    ['orders',{driverId:1,status:1,updatedAt:-1},{name:'idx_driver_orders'}],
    ['orders',{serviceCode:1,status:1,createdAt:1},{name:'idx_dispatch_orders'}],
    ['merchant_settlements',{merchantId:1,periodEnd:-1},{name:'idx_merchant_settlements'}],
  ];
  for(const [collection,key,options] of tasks){await db.collection(collection).createIndex(key,options);console.log(`+ ${collection}.${options.name}`);}
  await db.collection('app_settings').updateOne({key:'COMMERCE_SCHEMA_VERSION'},{$set:{key:'COMMERCE_SCHEMA_VERSION',value:'1.6.0',status:'ACTIVE',updatedAt:new Date()},$setOnInsert:{createdAt:new Date()}},{upsert:true});
  console.log('TH79 iMove commerce schema 1.6.0 READY'); await client.close();
}
main().catch(e=>{console.error('COMMERCE MIGRATION FAILED:',e);process.exit(1)});
