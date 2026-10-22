const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const Module=require('node:module');
const policy=require('../src/merchant_review_policy');
const ROOT=path.resolve(__dirname,'../src/commerce_routes.js');
const ORIGINAL_LOAD=Module._load;
let router;
// Route unit tests: isolate Mongo/Express adapters without requiring a running DB server.
function loadAdminRoutes(db){
  const routes={get:new Map(),post:new Map(),put:new Map()};
  const expressMock={Router(){return {use(){},get(key,...handlers){routes.get.set(key,handlers)},post(key,...handlers){routes.post.set(key,handlers)},put(key,...handlers){routes.put.set(key,handlers)}}}};
  Module._load=function(request,parent,isMain){
    if(parent?.filename===ROOT){
      if(request==='express')return expressMock;
      if(request==='mongodb')return {ObjectId:class{constructor(id){if(!/^[a-f0-9]{24}$/.test(id))throw Error('Invalid');this.value=id}toString(){return this.value}}};
      if(request==='multer')return Object.assign(()=>({single:()=>(_req,_res,next)=>next()}),{diskStorage:x=>x});
      if(request==='./auth_routes')return {createAuthenticate:()=>()=>{}};
      if(request==='./admin_guard')return {createAdminGuard:()=>({requireAdmin(_req,_res,next){next()},permit(permission){return (req,res,next)=>req.adminPermissions?.includes('*')||req.adminPermissions?.includes(permission)?next():res.status(403).json({message:'Thiếu quyền '+permission})}})};
      if(request==='./trusted_route_pricing')return {verifiedMetrics:()=>({})};
    }
    return ORIGINAL_LOAD.call(this,request,parent,isMain);
  };
  try {delete require.cache[ROOT];const commerce=require(ROOT);router=commerce.createCommerceAdminRouter({getDb:()=>db});}
  finally {Module._load=ORIGINAL_LOAD;delete require.cache[ROOT]}
  return routes;
}
function mockDb(merchant){
  const audit=[];
  const coll={findOne:async ({_id})=>String(_id)===String(merchant._id)?structuredClone(merchant):null,
    updateOne:async (filter,patch)=>{
      if(String(filter._id)!==merchant._id)return {matchedCount:0};
      if(filter.status && merchant.status!==filter.status)return {matchedCount:0};
      if(filter.approvalStatus){
        if(filter.approvalStatus.$exists===false && Object.hasOwn(merchant,'approvalStatus'))return {matchedCount:0};
        if(typeof filter.approvalStatus==='string'&&merchant.approvalStatus!==filter.approvalStatus)return {matchedCount:0};
      }
      Object.assign(merchant,patch.$set);return {matchedCount:1,modifiedCount:1};
    },
    find:()=>({sort:()=>({limit:()=>({toArray:async()=>[structuredClone(merchant)]})})}),
  };
  const db={collection(name){return name==='merchants'?coll:name==='audit_logs'?{insertOne:async entry=>{audit.push(entry)}}:{}}};
  return {db,audit};
}
function merchant(overrides={}){
  return {_id:'0123456789abcdef01234567',name:'Ngọc Phú Store',phone:'0901234567',address:'Quận Bình Tân, Thành phố Hồ Chí Minh',status:'PENDING',approvalStatus:'PENDING',reviewDocuments:{ID_FRONT:{filename:'a'.repeat(40)+'.img',originalName:'a.jpg',mime:'image/jpeg'},STOREFRONT:{filename:'b'.repeat(40)+'.img',originalName:'b.jpg',mime:'image/jpeg'}},...overrides};
}
async function invoke(routes,method,url,{request={},permissions=['merchants.view','merchants.approve','merchants.manage']}={}){
  const handlers=routes[method].get(url);assert.ok(handlers,'Missing route '+method+' '+url);
  const body=request.body||{};
  const req={params:{id:'0123456789abcdef01234567'},body,admin:{_id:'ADMIN_1'},adminPermissions:permissions};
  const res={code:200,status(code){this.code=code;return this},json(payload){this.body=payload;return this},end(){return this}};
  for(const h of handlers){let continued=false;await h(req,res,()=>{continued=true});if(!continued)break;}
  return res;
}
test('Pending registration cannot be treated as approved',()=>assert.equal(policy.reviewStatus(merchant()),'PENDING'));
test('Previously active legacy seeded shops stay operational',()=>assert.equal(policy.reviewStatus({status:'ACTIVE'}),'APPROVED'));
test('Required documents are enforced independently of approval',()=>{const x=merchant({reviewDocuments:{}});assert.ok(policy.missingReviewItems(x).length>=2)});
test('Do not expose stored document filenames in review summary',()=>{const summary=policy.reviewSummary(merchant());assert.equal(summary.reviewDocuments.ID_FRONT.filename,undefined);assert.equal(summary.reviewDocuments.ID_FRONT.originalName,'a.jpg')});
test('Complete pending shop can be approved with audit record',async()=>{
  const m=merchant(),{db,audit}=mockDb(m),routes=loadAdminRoutes(db);
  const res=await invoke(routes,'post','/merchants/:id/review',{request:{body:{decision:'APPROVE'}}});
  assert.equal(res.code,200);assert.equal(m.approvalStatus,'APPROVED');assert.equal(m.status,'ACTIVE');assert.equal(audit.length,1);assert.equal(audit[0].action,'MERCHANT_APPROVED');
});
test('Missing documents block approval',async()=>{
  const m=merchant({reviewDocuments:{}}),{db}=mockDb(m),routes=loadAdminRoutes(db);
  const res=await invoke(routes,'post','/merchants/:id/review',{request:{body:{decision:'APPROVE'}}});
  assert.equal(res.code,422);assert.equal(m.status,'PENDING');
});
test('Rejection requires a real reason',async()=>{
  const m=merchant(),{db}=mockDb(m),routes=loadAdminRoutes(db);
  const res=await invoke(routes,'post','/merchants/:id/review',{request:{body:{decision:'REJECT',reason:'bad'}}});
  assert.equal(res.code,400);assert.equal(m.approvalStatus,'PENDING');
});
test('Rejection stores reason and audit',async()=>{
  const m=merchant(),{db,audit}=mockDb(m),routes=loadAdminRoutes(db);
  const res=await invoke(routes,'post','/merchants/:id/review',{request:{body:{decision:'REJECT',reason:'Ảnh CCCD không đọc được'}}});
  assert.equal(res.code,200);assert.equal(m.approvalStatus,'REJECTED');assert.equal(m.status,'REJECTED');assert.match(m.reviewReason,/CCCD/);assert.equal(audit[0].action,'MERCHANT_REJECTED');
});
test('Only pending merchant is reviewable',async()=>{
  const m=merchant({status:'ACTIVE',approvalStatus:'APPROVED'}),{db}=mockDb(m),routes=loadAdminRoutes(db);
  const res=await invoke(routes,'post','/merchants/:id/review',{request:{body:{decision:'REJECT',reason:'Tài liệu chưa đầy đủ'}}});
  assert.equal(res.code,409);assert.equal(m.status,'ACTIVE');
});
test('Review requires merchants.approve distinct from view',async()=>{
  const m=merchant(),{db}=mockDb(m),routes=loadAdminRoutes(db);
  const res=await invoke(routes,'post','/merchants/:id/review',{request:{body:{decision:'APPROVE'}},permissions:['merchants.view']});
  assert.equal(res.code,403);assert.equal(m.status,'PENDING');
});
test('Generic merchant update cannot activate pending shop',async()=>{
  const m=merchant(),{db}=mockDb(m),routes=loadAdminRoutes(db);
  const res=await invoke(routes,'put','/merchants/:id',{request:{body:{status:'ACTIVE'}}});
  assert.equal(res.code,409);assert.equal(m.status,'PENDING');
});
test('Generic merchant update cannot activate shop with status typo',async()=>{
  const m=merchant({status:'ACTIVE',approvalStatus:'APPROVED'}),{db}=mockDb(m),routes=loadAdminRoutes(db);
  const res=await invoke(routes,'put','/merchants/:id',{request:{body:{status:'APPROVED'}}});
  assert.equal(res.code,400);
});
test('List view redacts private filename from review documents',async()=>{
  const m=merchant(),{db}=mockDb(m),routes=loadAdminRoutes(db);
  const res=await invoke(routes,'get','/merchants');
  assert.equal(res.code,200);assert.equal(res.body.merchants[0].reviewDocuments.ID_FRONT.filename,undefined);
});
