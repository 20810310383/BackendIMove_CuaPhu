'use strict';
// Dependency-free behavior checks for the v181 router contract (test doubles for IO packages).
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

function loadModule(){
  const routers=[];
  const makeRouter=()=>{
    const routes=[];
    const r={routes,use:()=>r};
    for(const method of ['get','post','put','delete'])r[method]=(route,...handlers)=>{routes.push({method,route,handlers});return r};
    routers.push(r);return r;
  };
  class ObjectId{constructor(value){if(!/^[a-f0-9]{24}$/i.test(String(value)))throw Error('invalid ID');this.value=String(value)}toString(){return this.value}}
  const multer=()=>({single:()=>((req,res,next)=>next())});
  multer.memoryStorage=()=>({});
  const mockRequire=x=>{
    if(x==='express')return {Router:makeRouter};
    if(x==='multer')return multer;
    if(x==='mongodb')return {ObjectId,GridFSBucket:class{}};
    if(x==='./admin_guard')return {createAdminGuard:()=>({requireAdmin:(req,res,next)=>next(),permit:()=>((req,res,next)=>next())})};
    throw Error(`Unexpected import: ${x}`);
  };
  const code=fs.readFileSync(path.resolve(__dirname,'../src/ad_banner_routes.js'),'utf8');
  const exports={};const ctx={require:mockRequire,module:{exports},exports,Buffer,Date,Number,String,Boolean,Math,JSON,Promise,Error,Array,RegExp,console};
  vm.runInNewContext(code,ctx,{filename:'ad_banner_routes.js'});
  return ctx.module.exports;
}
function fakeRes(){const res={code:200,body:null,headers:{},status(c){this.code=c;return this},json(data){this.body=data;return this},sendStatus(c){this.code=c;return this},set(k,v){if(typeof k==='string')this.headers[k]=v;else Object.assign(this.headers,k);return this}};return res}
const api=loadModule();

test('validImage accepts real PNG/JPEG/WebP headers and rejects others',()=>{
  assert.equal(api.validImage(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(8)])),'image/png');
  assert.equal(api.validImage(Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(12)])),'image/jpeg');
  assert.equal(api.validImage(Buffer.from('RIFF0000WEBPdata')),'image/webp');
  assert.equal(api.validImage(Buffer.from('<script>alert(1)</script>')),null);
});

test('schedule validation and title are required',()=>{
  assert.throws(()=>api.clean({title:''}),/tiêu đề/);
  assert.throws(()=>api.clean({title:'Test',startAt:'2026-10-15',endAt:'2026-10-14'}),/sau ngày bắt đầu/);
  assert.throws(()=>api.clean({title:'Test',sortOrder:-1}),/Thứ tự/);
  const v=api.clean({title:' Promo  ',sortOrder:2,enabled:true,promotionCode:'welcome20'});
  assert.equal(v.title,'Promo');assert.equal(v.promotionCode,'WELCOME20');assert.equal(v.enabled,true);
});

test('isCurrent blocks expired, scheduled and disabled banners',()=>{
  const now=new Date('2026-10-14T12:00:00Z');
  assert.equal(api.isCurrent({enabled:true,startAt:new Date('2026-10-14T00:00:00Z'),endAt:new Date('2026-10-16')},now),true);
  assert.equal(api.isCurrent({enabled:false},now),false);
  assert.equal(api.isCurrent({enabled:true,startAt:new Date('2026-10-15')},now),false);
  assert.equal(api.isCurrent({enabled:true,endAt:new Date('2026-10-13')},now),false);
});

test('public banner serialization never exposes admin IDs or raw image data',()=>{
  const item=api.publicBanner({_id:'507f1f77bcf86cd799439011',title:'Hello',imageFileId:'507f1f77bcf86cd799439012',enabled:true,updatedBy:'secret'});
  assert.match(item.imageUrl,/^\/api\/v181\/banners\/media\//);
  assert.equal(item.updatedBy,undefined);
  assert.equal(item.title,'Hello');
});

test('public list queries only active, in-range banners and caps results',async()=>{
  let findArg;let limitArg;
  const docs=[{_id:'507f1f77bcf86cd799439011',title:'Sale',enabled:true,imageFileId:'507f1f77bcf86cd799439012'}];
  const db={collection:()=>({find(query){findArg=query;return {sort:()=>({limit:n=>{limitArg=n;return {toArray:async()=>docs}}})}}})};
  const router=api.createAdBannerPublicRouter({getDb:()=>db});
  const handler=router.routes.find(x=>x.method==='get'&&x.route==='/').handlers[0];
  const response=fakeRes();await handler({},response);
  assert.equal(response.code,200);assert.equal(response.body.banners.length,1);
  assert.equal(findArg.enabled,true);assert.equal(limitArg,20);
});

test('Admin cannot create enabled banner before uploading an image',async()=>{
  const router=api.createAdBannerAdminRouter({getDb:()=>({collection:()=>({})})});
  const handler=router.routes.find(x=>x.method==='post'&&x.route==='/').handlers.at(-1);
  const res=fakeRes();await handler({body:{title:'B',enabled:true}},res);
  assert.equal(res.code,400);assert.match(res.body.message,/ảnh/);
});
