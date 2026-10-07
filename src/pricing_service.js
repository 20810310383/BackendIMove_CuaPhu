function n(v,f=0){const x=Number(v);return Number.isFinite(x)?x:f;}
function roundUp(v,unit){const u=Math.max(1,Math.round(n(unit,1)));return Math.ceil(Math.max(0,n(v))/u)*u;}
function distanceFare(distanceKm,tiers=[]){let total=0;for(const tier of [...tiers].sort((a,b)=>n(a.fromKm)-n(b.fromKm))){const from=n(tier.fromKm);const to=tier.toKm==null?distanceKm:n(tier.toKm);if(distanceKm<=from)continue;total+=Math.max(0,Math.min(distanceKm,to)-from)*n(tier.pricePerKm);}return Math.round(total);}
function calculateVersionedFare({config,fees={},distanceKm,durationMinutes,multipliers={},surcharges=[]}){
  if(!config)throw new Error('FARE_CONFIG_NOT_FOUND');
  const distance=n(distanceKm),duration=Math.max(0,n(durationMinutes));if(distance<=0)throw new Error('DISTANCE_INVALID');
  const baseFare=Math.round(n(config.baseFare));const dFare=distanceFare(distance,config.distanceTiers);const timeFare=Math.round(duration*n(config.pricePerMinute));
  let tripFare=Math.max(n(config.minimumFare),baseFare+dFare+timeFare);
  const multiplier=Math.max(0.1,n(multipliers.surge,1))*Math.max(0.1,n(multipliers.rush,1))*Math.max(0.1,n(multipliers.night,1));
  tripFare=Math.round(tripFare*multiplier);
  let surchargeTotal=0;for(const s of surcharges){const type=String(s.calculationType||'FIXED').toUpperCase();const value=n(s.value);surchargeTotal+=type==='PERCENT'?Math.round(tripFare*value/100):type==='MULTIPLIER'?Math.round(tripFare*Math.max(0,value-1)):Math.round(value);}
  const driverGrossAmount=tripFare+surchargeTotal;const bookingFee=Math.round(n(fees.bookingFee));const customerServiceFee=Math.round(n(fees.customerServiceFee));const paymentFee=Math.round((driverGrossAmount+bookingFee+customerServiceFee)*n(fees.paymentFeePercent)/100);
  const commission=fees.driverCommission||{type:'PERCENT',value:0};const platformCommission=String(commission.type||'PERCENT').toUpperCase()==='FIXED'?Math.round(n(commission.value)):Math.round(driverGrossAmount*n(commission.value)/100);const driverFixedFee=Math.round(n(fees.driverFixedFee));
  const total=roundUp(driverGrossAmount+bookingFee+customerServiceFee+paymentFee,config.roundingUnit||1);const driverNetAmount=Math.max(0,driverGrossAmount-platformCommission-driverFixedFee);
  return {total,customerTotal:total,driverGrossAmount,driverNetAmount,platformCommission,platformRevenueEstimate:bookingFee+customerServiceFee+paymentFee+platformCommission+driverFixedFee,breakdown:{baseFare,distanceFare:dFare,timeFare,tripFare,surchargeTotal,bookingFee,customerServiceFee,paymentFee},distanceKm:Number(distance.toFixed(3)),durationMinutes:Math.round(duration)};
}
async function findEffective(db,collection,serviceCode,areaCode='GLOBAL',at=new Date()){
  const common={serviceCode,status:'ACTIVE',$and:[{$or:[{effectiveFrom:null},{effectiveFrom:{$exists:false}},{effectiveFrom:{$lte:at}}]},{$or:[{effectiveTo:null},{effectiveTo:{$exists:false}},{effectiveTo:{$gt:at}}]}]};
  return await db.collection(collection).findOne({...common,areaCode},{sort:{version:-1}})|| (areaCode!=='GLOBAL'?await db.collection(collection).findOne({...common,areaCode:'GLOBAL'},{sort:{version:-1}}):null);
}
function createPricingService({getDb}){
  async function resolveActiveFare({serviceCode,areaCode='GLOBAL',at=new Date()}){return findEffective(getDb(),'fare_configs',String(serviceCode).toUpperCase(),String(areaCode).toUpperCase(),at);}
  async function estimateFare({serviceCode,areaCode='GLOBAL',distanceKm,durationMinutes}){
    const db=getDb();const code=String(serviceCode||'').toUpperCase();const area=String(areaCode||'GLOBAL').toUpperCase();
    const [config,fees,surcharges]=await Promise.all([findEffective(db,'fare_configs',code,area),findEffective(db,'platform_fees',code,area),db.collection('surcharges').find({serviceCode:code,status:'ACTIVE'}).toArray()]);
    if(!config)return {serviceCode:code,available:false,reason:`Không có bảng giá ACTIVE cho ${code}.`};
    const calc=calculateVersionedFare({config,fees:fees||{},distanceKm,durationMinutes,multipliers:{surge:1,rush:1,night:1},surcharges});
    const fareSnapshot={serviceCode:code,areaCode:area,currency:config.currency||'VND',fareConfigId:String(config._id),fareConfigVersion:n(config.version,1),platformFeeId:fees?String(fees._id):null,platformFeeVersion:n(fees?.version,0),...calc,calculatedAt:new Date()};
    return {serviceCode:code,available:true,fare:calc,fareSnapshot};
  }
  async function listFares(serviceCode){const q=serviceCode?{serviceCode:String(serviceCode).toUpperCase()}:{};return getDb().collection('fare_configs').find(q).sort({serviceCode:1,version:-1}).toArray();}
  async function createFareVersion(input,adminId=null){const db=getDb();const code=String(input.serviceCode||'').toUpperCase();const area=String(input.areaCode||'GLOBAL').toUpperCase();const last=await db.collection('fare_configs').findOne({serviceCode:code,areaCode:area},{sort:{version:-1}});const version=n(last?.version,0)+1;const now=new Date();const doc={...input,serviceCode:code,areaCode:area,version,status:String(input.status||'DRAFT').toUpperCase(),effectiveFrom:input.effectiveFrom?new Date(input.effectiveFrom):null,effectiveTo:input.effectiveTo?new Date(input.effectiveTo):null,createdAt:now,updatedAt:now,createdBy:adminId,updatedBy:adminId};const r=await db.collection('fare_configs').insertOne(doc);return {...doc,_id:r.insertedId};}
  async function updateFutureFare(id,patch,adminId=null){const {ObjectId}=require('mongodb');const _id=new ObjectId(String(id));const current=await getDb().collection('fare_configs').findOne({_id});if(!current)throw new Error('Không tìm thấy bảng giá.');if(current.status==='ACTIVE'&&(!current.effectiveFrom||new Date(current.effectiveFrom)<=new Date()))throw new Error('Bảng giá đã hiệu lực không được sửa trực tiếp; hãy tạo phiên bản mới.');await getDb().collection('fare_configs').updateOne({_id},{$set:{...patch,updatedAt:new Date(),updatedBy:adminId}});return getDb().collection('fare_configs').findOne({_id});}
  return {resolveActiveFare,estimateFare,listFares,createFareVersion,updateFutureFare};
}
module.exports={calculateVersionedFare,createPricingService};
