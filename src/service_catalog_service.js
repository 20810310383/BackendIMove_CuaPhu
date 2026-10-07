const SERVICE_CODES=['BIKE','DELIVERY','ERRAND','FOOD','CAR_4','CAR_7','MPV_7','LUXURY_4','LUXURY_7'];
const DEFAULT_SERVICES=[
  {code:'BIKE',name:'Xe máy',shortName:'Xe máy',category:'MOTORBIKE',seats:1,luggage:0,iconKey:'bike',sortOrder:10},
  {code:'DELIVERY',name:'Giao hàng',shortName:'Giao hàng',category:'COMMERCE',seats:1,luggage:1,iconKey:'delivery',sortOrder:12},
  {code:'ERRAND',name:'Mua hộ',shortName:'Mua hộ',category:'COMMERCE',seats:1,luggage:1,iconKey:'errand',sortOrder:14},
  {code:'FOOD',name:'Đặt đồ ăn',shortName:'Đồ ăn',category:'COMMERCE',seats:1,luggage:1,iconKey:'food',sortOrder:16},
  {code:'CAR_4',name:'Ô tô 4 chỗ',shortName:'4 chỗ',category:'CAR',seats:4,luggage:2,iconKey:'car_4',sortOrder:20},
  {code:'CAR_7',name:'Ô tô 7 chỗ',shortName:'7 chỗ',category:'CAR',seats:7,luggage:3,iconKey:'car_7',sortOrder:30},
  {code:'MPV_7',name:'MPV 7 chỗ',shortName:'MPV',category:'MPV',seats:7,luggage:4,iconKey:'mpv_7',sortOrder:40},
  {code:'LUXURY_4',name:'Luxury 4 chỗ',shortName:'Luxury 4',category:'PREMIUM',seats:4,luggage:2,iconKey:'luxury_4',sortOrder:50},
  {code:'LUXURY_7',name:'Luxury 7 chỗ',shortName:'Luxury 7',category:'PREMIUM',seats:7,luggage:3,iconKey:'luxury_7',sortOrder:60},
];
function normalizeService(input={}){
  const code=String(input.code||'').trim().toUpperCase();
  if(!SERVICE_CODES.includes(code))throw Object.assign(new Error('Mã dịch vụ không hợp lệ.'),{code:'SERVICE_CODE_INVALID'});
  return {code,name:String(input.name||code).trim(),shortName:String(input.shortName||input.name||code).trim(),category:String(input.category||'CAR').trim().toUpperCase(),seats:Math.max(1,Number(input.seats||1)),luggage:Math.max(0,Number(input.luggage||0)),iconKey:String(input.iconKey||code.toLowerCase()),sortOrder:Number(input.sortOrder||0),status:String(input.status||'ACTIVE').toUpperCase(),matchingEnabled:input.matchingEnabled!==false,customerVisible:input.customerVisible!==false};
}
function eligibleServiceCodes(vehicle){
  if(String(vehicle?.status||'').toUpperCase()!=='APPROVED')return [];
  const raw=Array.isArray(vehicle?.serviceCodes)?vehicle.serviceCodes:(vehicle?.serviceCode?[vehicle.serviceCode]:[]);
  return [...new Set(raw.map(x=>String(x).toUpperCase()).filter(x=>SERVICE_CODES.includes(x)))];
}
function driverCanServe(vehicle, serviceCode){return eligibleServiceCodes(vehicle).includes(String(serviceCode||'').toUpperCase());}
function createServiceCatalogService({getDb}){
  async function listAll(){return getDb().collection('service_catalog').find({}).sort({sortOrder:1,code:1}).toArray();}
  async function listActive(){return getDb().collection('service_catalog').find({status:'ACTIVE',customerVisible:{$ne:false}}).sort({sortOrder:1,code:1}).toArray();}
  async function getByCode(code){return getDb().collection('service_catalog').findOne({code:String(code||'').toUpperCase()});}
  async function saveService(input,adminId=null){
    const normalized=normalizeService(input);const now=new Date();
    await getDb().collection('service_catalog').updateOne({code:normalized.code},{$set:{...normalized,updatedAt:now,updatedBy:adminId},$setOnInsert:{createdAt:now}},{upsert:true});
    return getByCode(normalized.code);
  }
  return {listAll,listActive,getByCode,saveService,eligibleServiceCodes};
}
module.exports={SERVICE_CODES,DEFAULT_SERVICES,normalizeService,eligibleServiceCodes,driverCanServe,createServiceCatalogService};
