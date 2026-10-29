'use strict';
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { createAdminGuard } = require('./admin_guard');

function oid(value) { try { return value instanceof ObjectId ? value : new ObjectId(String(value)); } catch { return null; } }
function codeOf(value) { return String(value || '').trim().toUpperCase(); }
function validCode(value) { return /^[A-Z0-9]{5,20}$/.test(value); }
function normalizedPhone(value) { const phone=String(value||'').replace(/[^0-9]/g,''); return /^0[0-9]{9}$/.test(phone)?phone:null; }
function clean(value, max=160) { return String(value || '').trim().slice(0,max); }
function asId(doc) { if (!doc) return null; return { ...doc, _id:String(doc._id), ownerUserId:String(doc.ownerUserId||''), usedByUserId:doc.usedByUserId?String(doc.usedByUserId):null }; }
function httpError(code, message) { const error=new Error(message); error.status=code; return error; }
function handleError(res,error) { res.status(error.status || 500).json({message:error.status ? error.message : 'Không xử lý được yêu cầu. Hãy kiểm tra log máy chủ.'}); }

const referralIndexes = new WeakMap();
async function ensureReferralIndexes(db) {
  let promise = referralIndexes.get(db);
  if (!promise) {
    promise = makeIndexes(db).catch(error => {referralIndexes.delete(db); throw error;});
    referralIndexes.set(db,promise);
  }
  return promise;
}

async function makeIndexes(db) {
  await Promise.all([
    db.collection('referral_codes').createIndex({code:1},{unique:true}),
    db.collection('referral_codes').createIndex({ownerUserId:1,sourceType:1},{unique:true,partialFilterExpression:{sourceType:'USER',status:'ACTIVE'}}),
    db.collection('referral_redemptions').createIndex({usedByUserId:1},{unique:true}),
    db.collection('referral_redemptions').createIndex({code:1,sourceApp:1,createdAt:-1}),
    db.collection('referral_rewards').createIndex({redemptionId:1},{unique:true}),
  ]);
}

function createReferralRouter({getDb}) {
  const router=express.Router({mergeParams:true});
  router.use(async (req,res,next)=>{try{await ensureReferralIndexes(getDb());next();}catch(e){handleError(res,httpError(503,'Không khởi tạo được chỉ mục referral; từ chối ghi để tránh trùng thưởng.'));}});
  router.use(async (req,res,next)=>{
    try {
      const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
      if(!token) throw httpError(401,'Thiếu phiên đăng nhập.');
      const payload=jwt.verify(token,String(process.env.JWT_ACCESS_SECRET||''), {issuer:'th79-imove',audience:'th79-imove-apps'});
      const id=oid(payload.sub);
      const user=id && await getDb().collection('users').findOne({_id:id,status:{$ne:'BLOCKED'}});
      if(!user) throw httpError(401,'Tài khoản không hợp lệ.');
      const source=String(req.params.app||'').toUpperCase();
      if(!['CUSTOMER','DRIVER','MERCHANT'].includes(source)) throw httpError(400,'Ứng dụng không hợp lệ.');
      const roles=Array.isArray(user.roles)?user.roles:[];
      if(source==='CUSTOMER'&&!roles.includes('CUSTOMER')) throw httpError(403,'Không phải tài khoản User.');
      if(source==='DRIVER'&&!roles.includes('DRIVER')) throw httpError(403,'Không phải tài khoản Driver.');
      if(source==='MERCHANT') {
        const active=await getDb().collection('merchant_users').findOne({userId:id,status:'ACTIVE'});
        if(!active) throw httpError(403,'Không phải tài khoản Merchant đang hoạt động.');
      }
      req.referralUser=user;req.referralSource=source;next();
    }catch(e) {handleError(res,e.status?e:httpError(401,'Phiên đăng nhập không hợp lệ.'));}
  });
  router.get('/me',async(req,res)=>{
    try{
      const db=getDb(), owner=req.referralUser._id;
      const [codes,attribution]=await Promise.all([
        db.collection('referral_codes').find({ownerUserId:owner,status:'ACTIVE'}).limit(15).toArray(),
        db.collection('referral_redemptions').findOne({usedByUserId:owner}),
      ]);
      res.json({codes:codes.map(asId),myReferralCode:normalizedPhone(req.referralUser.phone),applied:attribution?{code:attribution.code,sourceApp:attribution.sourceApp,status:attribution.status,createdAt:attribution.createdAt}:null});
    }catch(e){handleError(res,e)}
  });
  router.post('/my-code',async(req,res)=>{
    try{
      // Mọi tài khoản có số điện thoại hợp lệ đều dùng SĐT làm mã giới thiệu.
      const db=getDb(), uid=req.referralUser._id;
      let row=await db.collection('referral_codes').findOne({ownerUserId:uid,sourceType:'USER',status:'ACTIVE'});
      const phoneCode=normalizedPhone(req.referralUser.phone);
      if(!phoneCode)throw httpError(400,'SĐT tài khoản không hợp lệ.');
      if(!row){
        const code=normalizedPhone(req.referralUser.phone);
        if(!code) throw httpError(400,'Tài khoản chưa có số điện thoại Việt Nam hợp lệ để làm mã giới thiệu.');
        row={code,ownerUserId:uid,sourceType:'USER',partnerName:'',status:'ACTIVE',createdAt:new Date()};
        try {await db.collection('referral_codes').insertOne(row)}
        catch(e){if(e.code===11000) row=await db.collection('referral_codes').findOne({ownerUserId:uid,sourceType:'USER',status:'ACTIVE'});else throw e;}
      }
      res.json({code:phoneCode,legacyCode:row.code!==phoneCode?row.code:null});
    }catch(e){handleError(res,e)}
  });
  router.post('/apply',async(req,res)=>{
    try{
      const db=getDb(),uid=req.referralUser._id,code=codeOf(req.body?.code);
      if(!validCode(code)) throw httpError(400,'Mã giới thiệu phải gồm 5–20 chữ/số.');
      let owner=await db.collection('referral_codes').findOne({code,status:'ACTIVE'});
      if(!owner && normalizedPhone(code)) {
        const customer=await db.collection('users').findOne({phone:code,status:'ACTIVE'});
        if(customer) {
          const existing=await db.collection('referral_codes').findOne({code});
          if(existing && existing.status!=='ACTIVE') throw httpError(404,'Mã giới thiệu đã bị ngừng.');
          const oldOwnerCode=await db.collection('referral_codes').findOne({ownerUserId:customer._id,sourceType:'USER',status:'ACTIVE'});
          if(oldOwnerCode){owner=oldOwnerCode;}
          else {
          const candidate={code,ownerUserId:customer._id,sourceType:'USER',ownerPhone:code,status:'ACTIVE',createdAt:new Date()};
          try { await db.collection('referral_codes').insertOne(candidate); owner=candidate; }
          catch(e) { if(e.code!==11000) throw e; owner=await db.collection('referral_codes').findOne({code,status:'ACTIVE'}); }
          }
        }
      }
      if(!owner) throw httpError(404,'Không tìm thấy mã giới thiệu đang hoạt động. Hãy kiểm tra SĐT chủ mã.');
      if(String(owner.ownerUserId)===String(uid)) throw httpError(400,'Không thể sử dụng mã của chính mình.');
      const old=await db.collection('referral_redemptions').findOne({usedByUserId:uid});
      if(old) throw httpError(409,'Tài khoản đã nhập mã giới thiệu trước đó.');
      let completed=0;
      if(req.referralSource==='DRIVER') {
        const driver=await db.collection('drivers').findOne({userId:uid});
        if(driver) completed=await db.collection('bookings').countDocuments({driverId:driver._id,status:'COMPLETED'},{limit:1});
      } else if(req.referralSource==='MERCHANT') {
        const membership=await db.collection('merchant_users').find({userId:uid,status:'ACTIVE'}).project({merchantId:1}).toArray();
        if(membership.length) completed=await db.collection('orders').countDocuments({merchantId:{$in:membership.map(x=>x.merchantId)},status:{$in:['DELIVERED','COMPLETED']}},{limit:1});
      } else completed=await db.collection('bookings').countDocuments({customerId:uid,status:'COMPLETED'},{limit:1});
      if(completed) throw httpError(409,'Chỉ tài khoản chưa hoàn tất đơn/chuyến đầu tiên mới được nhập mã giới thiệu.');
      const doc={code,referralCodeId:owner._id,ownerUserId:owner.ownerUserId,usedByUserId:uid,sourceApp:req.referralSource,
        sourceType:owner.sourceType,partnerName:owner.partnerName||'',status:'ATTRIBUTED',createdAt:new Date()};
      await db.collection('referral_redemptions').insertOne(doc);
      res.status(201).json({ok:true,code,status:doc.status,message:'Đã ghi nhận mã. Phần thưởng do Admin duyệt sau chuyến hợp lệ.'});
    }catch(e){if(e.code===11000)return res.status(409).json({message:'Tài khoản đã nhập mã giới thiệu.'});handleError(res,e)}
  });
  return router;
}

function createReferralAdminRouter({getDb}) {
  const router=express.Router(),{requireAdmin,permit}=createAdminGuard({getDb});
  router.use(requireAdmin);
  router.use(async (req,res,next)=>{try{await ensureReferralIndexes(getDb());next();}catch(e){handleError(res,httpError(503,'Không khởi tạo được chỉ mục referral.'));}});
  router.get('/codes',permit('promotions.view'),async(req,res)=>{
    try { const rows=await getDb().collection('referral_codes').find({}).sort({createdAt:-1}).limit(300).toArray();res.json({codes:rows.map(asId)});}
    catch(e){handleError(res,e)}
  });
  router.post('/codes',permit('promotions.manage'),async(req,res)=>{
    try {
      const db=getDb(),code=codeOf(req.body?.code), owner=oid(req.body?.ownerUserId);
      if(!validCode(code)) throw httpError(400,'Mã cần có 5–20 chữ/số.');
      if(!owner) throw httpError(400,'Chọn User chủ mã có ID hợp lệ.');
      const user=await db.collection('users').findOne({_id:owner,roles:'CUSTOMER'});
      if(!user) throw httpError(404,'Không tìm thấy tài khoản User chủ mã.');
      const sourceType=String(req.body?.sourceType||'USER').toUpperCase();
      if(!['USER','COLLAB'].includes(sourceType)) throw httpError(400,'Loại đối tác không hợp lệ.');
      const doc={code,ownerUserId:owner,ownerPhone:user.phone,ownerName:user.fullName,sourceType,
        partnerName:sourceType==='COLLAB'?clean(req.body?.partnerName,120):'',status:'ACTIVE',createdBy:req.admin._id,createdAt:new Date()};
      await db.collection('referral_codes').insertOne(doc);
      res.status(201).json({code});
    }catch(e){if(e.code===11000)return res.status(409).json({message:'Mã này đã tồn tại.'});handleError(res,e)}
  });
  router.patch('/codes/:code',permit('promotions.manage'),async(req,res)=>{
    try{
      const status=String(req.body?.status||'').toUpperCase();
      if(!['ACTIVE','DISABLED'].includes(status))throw httpError(400,'Trạng thái không hợp lệ.');
      const r=await getDb().collection('referral_codes').updateOne({code:codeOf(req.params.code)},{$set:{status,updatedAt:new Date(),updatedBy:req.admin._id}});
      if(!r.matchedCount)throw httpError(404,'Không có mã giới thiệu.');
      res.json({ok:true,status});
    }catch(e){handleError(res,e)}
  });
  router.get('/redemptions',permit('promotions.view'),async(req,res)=>{
    try{
      const db=getDb(), rows=await db.collection('referral_redemptions').find({}).sort({createdAt:-1}).limit(250).toArray();
      const userIds=[...new Set(rows.flatMap(r=>[String(r.ownerUserId),String(r.usedByUserId)]))].map(oid).filter(Boolean);
      const users=await db.collection('users').find({_id:{$in:userIds}}).project({fullName:1,phone:1}).toArray();
      const lookup=new Map(users.map(u=>[String(u._id),u]));
      res.json({redemptions:rows.map(r=>({id:String(r._id),code:r.code,sourceApp:r.sourceApp,sourceType:r.sourceType,partnerName:r.partnerName,
        ownerUserId:String(r.ownerUserId),ownerName:lookup.get(String(r.ownerUserId))?.fullName||'',
        usedByUserId:String(r.usedByUserId),usedByName:lookup.get(String(r.usedByUserId))?.fullName||'',
        usedByPhone:lookup.get(String(r.usedByUserId))?.phone||'',status:r.status,createdAt:r.createdAt}))});
    }catch(e){handleError(res,e)}
  });
  router.post('/redemptions/:id/reward',permit('promotions.manage'),async(req,res)=>{
    const db=getDb(),id=oid(req.params.id);
    if(!id)return res.status(400).json({message:'ID lượt giới thiệu không hợp lệ.'});
    const kind=String(req.body?.kind||'').toUpperCase();
    if(!['POINTS','COUPON'].includes(kind))return res.status(400).json({message:'Chọn POINTS hoặc COUPON.'});
    if(kind==='POINTS' && !(req.adminPermissions||[]).some(x=>x==='*'||x==='payments.manage'))
      return res.status(403).json({message:'Thưởng điểm cần quyền payments.manage (Tài chính).'});
    const points=Math.trunc(Number(req.body?.points||0));
    const discount=Math.trunc(Number(req.body?.discountVnd||0));
    if(kind==='POINTS'&&(!Number.isSafeInteger(points)||points<1||points>10000))return res.status(400).json({message:'Số điểm thưởng từ 1 đến 10.000.'});
    if(kind==='COUPON'&&(!Number.isSafeInteger(discount)||discount<1000||discount>1000000))return res.status(400).json({message:'Giá trị voucher từ 1.000 đến 1.000.000 đồng.'});
    const session=db.client?.startSession?.() || db.s?.client?.startSession?.();
    if(!session)return res.status(503).json({message:'MongoDB session không khả dụng; chưa cấp thưởng để tránh ghi thiếu giao dịch.'});
    try{
      let code=null;
      await session.withTransaction(async()=>{
        const row=await db.collection('referral_redemptions').findOne({_id:id},{session});
        if(!row)throw httpError(404,'Không tìm thấy lượt giới thiệu.');
        if(row.status==='REWARDED')throw httpError(409,'Lượt này đã thưởng trước đó.');
        let qualified=false;
        if(row.sourceApp==='DRIVER') {
          const drv=await db.collection('drivers').findOne({userId:row.usedByUserId},{session});
          if(drv) qualified=Boolean(await db.collection('bookings').countDocuments({driverId:drv._id,status:'COMPLETED'},{session,limit:1}));
        } else if(row.sourceApp==='MERCHANT') {
          const memberships=await db.collection('merchant_users').find({userId:row.usedByUserId,status:'ACTIVE'},{session}).project({merchantId:1}).toArray();
          const ids=memberships.map(m=>m.merchantId);
          if(ids.length) qualified=Boolean(await db.collection('orders').countDocuments({merchantId:{$in:ids},status:{$in:['DELIVERED','COMPLETED']}},{session,limit:1}));
        } else qualified=Boolean(await db.collection('bookings').countDocuments({customerId:row.usedByUserId,status:'COMPLETED'},{session,limit:1}));
        if(!qualified) throw httpError(409,'Tài khoản được giới thiệu chưa có đơn/chuyến hoàn thành hợp lệ.');
        const now=new Date();
        await db.collection('referral_rewards').insertOne({redemptionId:row._id,ownerUserId:row.ownerUserId,kind,
          value:kind==='POINTS'?points:discount,createdBy:req.admin._id,createdAt:now},{session});
        if(kind==='POINTS'){
          await db.collection('loyalty_accounts').updateOne({userId:row.ownerUserId},{$setOnInsert:{userId:row.ownerUserId,balance:0,lifetimeEarned:0,lifetimeSpent:0,createdAt:now}},{upsert:true,session});
          const updated=await db.collection('loyalty_accounts').findOneAndUpdate({userId:row.ownerUserId},{$inc:{balance:points,lifetimeEarned:points},$set:{updatedAt:now}},{returnDocument:'after',session});
          const account=updated?._id?updated:updated?.value;
          if(!account)throw httpError(500,'Không tính được số dư sau thưởng.');
          await db.collection('loyalty_transactions').insertOne({userId:row.ownerUserId,bookingId:null,type:'REFERRAL_REWARD',title:`Thưởng giới thiệu ${row.code}`,points,balanceAfter:account.balance,reference:`REFERRAL:${String(row._id)}`,status:'COMPLETED',createdAt:now},{session});
        } else {
          code='R'+crypto.randomBytes(6).toString('hex').toUpperCase();
          await db.collection('promotions').insertOne({code,name:`Ưu đãi giới thiệu ${row.code}`,status:'ACTIVE',discountType:'FIXED',discountValue:discount,value:discount,
            maxDiscount:discount,minOrderAmount:0,minOrderValue:0,serviceCodes:[],audienceType:'USERS',targetUserIds:[row.ownerUserId],perUserLimit:1,totalUsageLimit:1,usageLimit:1,
            newCustomerOnly:false,startAt:now,startsAt:now,endAt:new Date(now.getTime()+30*86400000),endsAt:new Date(now.getTime()+30*86400000),createdAt:now,createdBy:req.admin._id},{session});
        }
        await db.collection('referral_redemptions').updateOne({_id:id},{$set:{status:'REWARDED',rewardKind:kind,rewardValue:kind==='POINTS'?points:discount,
          rewardCoupon:code,rewardedAt:now,rewardedBy:req.admin._id}},{session});
        await db.collection('audit_logs').insertOne({actorType:'ADMIN',actorId:req.admin._id,action:'REFERRAL_REWARD',entityType:'REFERRAL',entityId:String(row._id),after:{kind,points:kind==='POINTS'?points:null,discountVnd:kind==='COUPON'?discount:null,coupon:code},createdAt:now},{session});
      });
      res.status(201).json({ok:true,kind,coupon:code});
    }catch(e){ if(e.code===11000)return res.status(409).json({message:'Lượt đã được thưởng, không thể thưởng hai lần.'});handleError(res,e) }
    finally{await session.endSession()}
  });
  return router;
}
module.exports={createReferralRouter,createReferralAdminRouter,codeOf,validCode};
