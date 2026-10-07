require('dotenv').config();
const {MongoClient}=require('mongodb');
const bcrypt=require('bcryptjs');
(async()=>{
  const uri=String(process.env.MONGODB_URI||'');if(!uri)throw new Error('Thiếu MONGODB_URI');
  const client=new MongoClient(uri);await client.connect();const db=client.db(String(process.env.MONGODB_DB||'th79_imove'));
  const phone=String(process.env.DEMO_MERCHANT_PHONE||'0909000099');
  const password=String(process.env.DEMO_MERCHANT_PASSWORD||'Merchant@160');
  const hash=await bcrypt.hash(password,12);const now=new Date();
  let user=await db.collection('users').findOne({phone});
  if(!user){const doc={phone,fullName:'Merchant Demo TH79',email:'merchant.demo@th79.vn',passwordHash:hash,status:'ACTIVE',roles:['MERCHANT'],createdAt:now,updatedAt:now};const x=await db.collection('users').insertOne(doc);user={...doc,_id:x.insertedId};}
  else{await db.collection('users').updateOne({_id:user._id},{$set:{passwordHash:hash,status:'ACTIVE',updatedAt:now},$addToSet:{roles:'MERCHANT'}});}
  let merchant=await db.collection('merchants').findOne({code:'TH79-DEMO-FOOD'});
  if(!merchant){const doc={code:'TH79-DEMO-FOOD',name:'Bếp TH79 Demo',categoryCode:'FOOD',address:'TP. Hồ Chí Minh',location:{type:'Point',coordinates:[106.700981,10.776889]},phone,status:'ACTIVE',rating:5,commissionRate:15,pickupInstruction:'Nhận món tại quầy đối tác iMove.',createdAt:now,updatedAt:now};const x=await db.collection('merchants').insertOne(doc);merchant={...doc,_id:x.insertedId};}
  await db.collection('merchant_users').updateOne({userId:user._id},{$set:{userId:user._id,merchantId:merchant._id,role:'OWNER',status:'ACTIVE',updatedAt:now},$setOnInsert:{createdAt:now}},{upsert:true});
  const count=await db.collection('products').countDocuments({merchantId:merchant._id});
  if(!count)await db.collection('products').insertMany([
    {merchantId:merchant._id,name:'Cơm gà TH79',description:'Món demo cho môi trường development.',categoryName:'Món chính',price:55000,status:'ACTIVE',stockStatus:'AVAILABLE',sortOrder:10,createdAt:now,updatedAt:now},
    {merchantId:merchant._id,name:'Trà đào',description:'Món demo.',categoryName:'Đồ uống',price:25000,status:'ACTIVE',stockStatus:'AVAILABLE',sortOrder:20,createdAt:now,updatedAt:now},
  ]);
  console.log(`Merchant demo ready: ${phone} / ${password}`);await client.close();
})().catch(e=>{console.error(e);process.exit(1)});
