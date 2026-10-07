function normalizePromotionCode(v){return String(v||'').trim().toUpperCase();}
function numberValue(v,fallback=0){const n=Number(v);return Number.isFinite(n)?n:fallback;}
function promoDiscountValue(p){return numberValue(p?.discountValue ?? p?.value,0);}
function promoMinOrder(p){return numberValue(p?.minOrderAmount ?? p?.minOrderValue,0);}
function promoTotalLimit(p){return numberValue(p?.totalUsageLimit ?? p?.usageLimit,0);}
function promoStart(p){return p?.startAt ?? p?.startsAt ?? null;}
function promoEnd(p){return p?.endAt ?? p?.endsAt ?? null;}
function isNewCustomerEligible(promotion,completedTrips){return !promotion?.newCustomerOnly || Math.max(0,Number(completedTrips)||0)===0;}
function calculatePromotionDiscount(promotion,amount){const fare=Math.max(0,Number(amount)||0);const type=String(promotion?.discountType||'FIXED').toUpperCase();let discount=type==='PERCENT'?fare*promoDiscountValue(promotion)/100:promoDiscountValue(promotion);if(Number(promotion?.maxDiscount)>0)discount=Math.min(discount,Number(promotion.maxDiscount));return Math.max(0,Math.min(fare,Math.round(discount)));}
function publicPromotion(p){if(!p)return p;return {...p,discountValue:promoDiscountValue(p),minOrderAmount:promoMinOrder(p),totalUsageLimit:promoTotalLimit(p),startAt:promoStart(p),endAt:promoEnd(p)};}
function createPromotionService({getDb}){
  const {ObjectId}=require('mongodb');
  function toOid(v){try{return new ObjectId(String(v));}catch(_){return null;}}
  async function resolveTargetUsers(input){const db=getDb();const raw=Array.isArray(input)?input:[];const ids=[],phones=[];for(const x of raw){const v=String(x||'').trim();if(!v)continue;const id=toOid(v);if(id)ids.push(id);else phones.push(v.replace(/\s+/g,''));}if(phones.length){const rows=await db.collection('users').find({phone:{$in:phones}}).project({_id:1}).toArray();ids.push(...rows.map(x=>x._id));}return [...new Map(ids.map(x=>[String(x),x])).values()];}
  async function validatePromotion({userId,code,serviceCode,orderAmount,now=new Date()}){const db=getDb();const normalized=normalizePromotionCode(code);if(!normalized)throw new Error('PROMOTION_CODE_REQUIRED');const p=await db.collection('promotions').findOne({code:normalized,status:'ACTIVE'});if(!p)throw new Error('Mã khuyến mãi không tồn tại hoặc đã tắt.');if(String(p.audienceType||'ALL').toUpperCase()==='USERS'){if(!userId)throw new Error('Mã này chỉ dành cho tài khoản được cấp.');const allowed=(Array.isArray(p.targetUserIds)?p.targetUserIds:[]).some(x=>String(x)===String(userId));if(!allowed)throw new Error('Mã này không được cấp cho tài khoản của bạn.');}const start=promoStart(p),end=promoEnd(p);if(start&&new Date(start)>now)throw new Error('Mã khuyến mãi chưa bắt đầu.');if(end&&new Date(end)<=now)throw new Error('Mã khuyến mãi đã hết hạn.');const services=Array.isArray(p.serviceCodes)?p.serviceCodes:[];if(services.length&&!services.includes(String(serviceCode).toUpperCase()))throw new Error('Mã không áp dụng cho loại dịch vụ này.');if(Number(orderAmount)<promoMinOrder(p))throw new Error('Chưa đạt giá trị chuyến tối thiểu.');const totalLimit=promoTotalLimit(p);if(totalLimit>0){const used=await db.collection('promotion_redemptions').countDocuments({promotionId:p._id,status:'REDEEMED'});if(used>=totalLimit)throw new Error('Mã đã hết lượt sử dụng.');}if(userId&&Number(p.perUserLimit)>0){const used=await db.collection('promotion_redemptions').countDocuments({promotionId:p._id,userId:new ObjectId(String(userId)),status:'REDEEMED'});if(used>=Number(p.perUserLimit))throw new Error('Bạn đã dùng hết lượt của mã này.');}if(userId&&p.newCustomerOnly){const completedTrips=await db.collection('bookings').countDocuments({customerId:new ObjectId(String(userId)),status:'COMPLETED'},{limit:1});if(!isNewCustomerEligible(p,completedTrips))throw new Error('Mã chỉ áp dụng cho khách hàng mới.');}const discount=calculatePromotionDiscount(p,orderAmount);return {promotion:publicPromotion(p),discount,finalAmount:Math.max(0,Math.round(Number(orderAmount)-discount)),snapshot:{promotionId:String(p._id),code:p.code,name:p.name,discountType:p.discountType,discountValue:promoDiscountValue(p),maxDiscount:Number(p.maxDiscount||0),discountAmount:discount,validatedAt:now}};}
  async function eligible({userId,serviceCode,orderAmount=0}){const rows=await getDb().collection('promotions').find({status:'ACTIVE',$or:[{serviceCodes:String(serviceCode).toUpperCase()},{serviceCodes:{$size:0}},{serviceCodes:{$exists:false}}]}).sort({endAt:1,endsAt:1}).limit(50).toArray();const out=[];for(const p of rows){try{out.push(await validatePromotion({userId,code:p.code,serviceCode,orderAmount}));}catch(_){}}return out.map(x=>({...x.promotion,_id:String(x.promotion._id),previewDiscount:x.discount}));}
  async function redeemPromotion({bookingId,userId,promotionId,discountAmount}){const db=getDb();const now=new Date();const doc={bookingId:new ObjectId(String(bookingId)),promotionId:new ObjectId(String(promotionId)),userId:new ObjectId(String(userId)),discountAmount:Number(discountAmount||0),status:'REDEEMED',createdAt:now,updatedAt:now};try{await db.collection('promotion_redemptions').insertOne(doc);return {ok:true,duplicate:false};}catch(e){if(e.code===11000)return {ok:true,duplicate:true};throw e;}}
  async function listAll(){return (await getDb().collection('promotions').find({}).sort({createdAt:-1}).toArray()).map(publicPromotion);}
  async function save(input,adminId=null){
    const db=getDb(),now=new Date(),code=normalizePromotionCode(input.code);
    if(!code)throw new Error('Thiếu mã khuyến mãi.');
    const name=String(input.name||code).trim();if(!name)throw new Error('Thiếu tên chương trình.');
    const discountType=String(input.discountType||'PERCENT').toUpperCase();if(!['PERCENT','FIXED'].includes(discountType))throw new Error('Kiểu giảm không hợp lệ.');
    const discountValue=Math.max(0,numberValue(input.discountValue ?? input.value,0));
    if(discountValue<=0)throw new Error('Giá trị giảm phải lớn hơn 0.');
    const minOrderAmount=Math.max(0,numberValue(input.minOrderAmount ?? input.minOrderValue,0));
    const totalUsageLimit=Math.max(0,Math.trunc(numberValue(input.totalUsageLimit ?? input.usageLimit,0)));
    const startAt=input.startAt||input.startsAt?new Date(input.startAt||input.startsAt):null;
    const endAt=input.endAt||input.endsAt?new Date(input.endAt||input.endsAt):null;
    if(startAt&&Number.isNaN(startAt.getTime()))throw new Error('Thời gian bắt đầu không hợp lệ.');
    if(endAt&&Number.isNaN(endAt.getTime()))throw new Error('Thời gian kết thúc không hợp lệ.');
    if(startAt&&endAt&&endAt<=startAt)throw new Error('Thời gian kết thúc phải sau thời gian bắt đầu.');
    const audienceType=String(input.audienceType||'ALL').toUpperCase()==='USERS'?'USERS':'ALL';
    const targetUserIds=audienceType==='USERS'?await resolveTargetUsers(input.targetUsers||input.targetUserIds||[]):[];
    if(audienceType==='USERS'&&!targetUserIds.length)throw new Error('Hãy chọn ít nhất một User để cấp mã riêng.');
    const doc={
      code,name,status:String(input.status||'ACTIVE').toUpperCase(),discountType,audienceType,targetUserIds,
      // 1.6 canonical fields
      discountValue,maxDiscount:Math.max(0,numberValue(input.maxDiscount,0)),minOrderAmount,
      serviceCodes:(Array.isArray(input.serviceCodes)?input.serviceCodes:[]).map(x=>String(x).toUpperCase()),
      totalUsageLimit,perUserLimit:Math.max(0,Math.trunc(numberValue(input.perUserLimit,0))),
      newCustomerOnly:Boolean(input.newCustomerOnly),startAt,endAt,
      // legacy aliases retained so databases still using the pre-1.6 validator
      // can accept the write before startup repair upgrades the validator.
      value:discountValue,minOrderValue:minOrderAmount,usageLimit:totalUsageLimit,startsAt:startAt,endsAt:endAt,
      updatedAt:now,updatedBy:adminId,
    };
    await db.collection('promotions').updateOne({code},{$set:doc,$setOnInsert:{createdAt:now,createdBy:adminId}},{upsert:true});
    return publicPromotion(await db.collection('promotions').findOne({code}));
  }
  return {validatePromotion,eligible,redeemPromotion,listAll,save};
}
module.exports={normalizePromotionCode,isNewCustomerEligible,calculatePromotionDiscount,createPromotionService};
