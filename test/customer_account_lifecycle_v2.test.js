'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');
const originalLoad = Module._load;
class ObjectId {
  constructor(hex) { this.hex = hex || '123456789abcdef012345678'; }
  toString() { return this.hex; }
  static isValid(hex) { return /^[0-9a-f]{24}$/i.test(String(hex)); }
}
Module._load = function(name, ...rest) {
  if (name === 'mongodb') return { ObjectId };
  return originalLoad.call(this, name, ...rest);
};
const lifecycle = require('../src/customer_account_lifecycle');
Module._load = originalLoad;
process.env.ACCOUNT_DELETION_HMAC_KEY = 'test-secret-hmac-123456789abcdef01234567890';
const u = () => ({ _id: new ObjectId('123456789abcdef012345678'), roles: ['CUSTOMER'], status:'ACTIVE', phone:'0901234567', fullName:'Nguyễn Văn A', email:'old@example.vn', passwordHash:'secret' });
class FakeCollection {
  constructor(docs = []) { this.docs = docs; }
  async findOne(filter={}) {return this.docs.find(d=>match(d,filter)) || null;}
  async countDocuments(filter={}) {return this.docs.filter(d=>match(d,filter)).length;}
  find(filter={}) {return {toArray:async()=>this.docs.filter(d=>match(d,filter))};}
  async updateOne(filter,update) {
    const item=await this.findOne(filter);
    if(!item) return {matchedCount:0,modifiedCount:0};
    Object.assign(item,update.$set||{});
    for(const k of Object.keys(update.$unset||{})) delete item[k];
    return {matchedCount:1,modifiedCount:1};
  }
  async updateMany(filter,update) {
    let n=0;
    for(const doc of this.docs.filter(d=>match(d,filter))) {Object.assign(doc,update.$set||{});n++;}
    return {matchedCount:n};
  }
}
function match(doc,filter) {
  for(const [k,v] of Object.entries(filter)) {
    if(k==='$or'){if(!v.some(f=>match(doc,f)))return false;continue;}
    let x=doc[k];
    if(v && typeof v==='object' && !(v instanceof ObjectId) && !(v instanceof Date) && !Array.isArray(v)) {
      if('$ne' in v) {if(x===v.$ne)return false;continue;}
      if('$nin' in v) {if(v.$nin.includes(x))return false;continue;}
      if('$in' in v) {if(!v.$in.some(item=>String(item)===String(x)))return false;continue;}
    }
    if(Array.isArray(x) && !Array.isArray(v)) {if(!x.includes(v))return false;}
    else if(String(x)!==String(v))return false;
  }
  return true;
}
function dbFor(user,other={}) {
 const data={ users:[user], auth_sessions:[{userId:user._id,revokedAt:null}], device_tokens:[{userId:user._id,enabled:true}],referral_codes:[{_id:new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),ownerUserId:user._id,code:user.phone,status:'ACTIVE',ownerPhone:user.phone,ownerName:user.fullName}],bookings:[],orders:[],wallets:[],payments:[],...other};
 const collections=Object.fromEntries(Object.entries(data).map(([k,v])=>[k,new FakeCollection(v)]));
 return {db:{collection:k=>collections[k]||(collections[k]=new FakeCollection())},collections};
}
test('đóng tài khoản có lịch sử đã hoàn tất: vẫn giữ customerId nhưng giải phóng số',async()=>{
 const user=u(), booking={customerId:user._id,status:'COMPLETED'};
 const {db,collections}=dbFor(user,{bookings:[booking]});
 const r=await lifecycle.softDeleteCustomer(db,user,{reason:'USER_REQUEST'});
 assert.equal(r.status,'DELETED');assert.equal(user.phone,'DELETED_'+String(user._id));assert.equal(user.fullName,'Tài khoản đã xóa');
 assert.equal(user.email,undefined);assert.equal(user.passwordHash,undefined);
 assert.equal(user.deletedPhoneHash,lifecycle.deletedPhoneHash('0901234567'));
 assert.equal(collections.auth_sessions.docs[0].revokedAt instanceof Date,true);
 assert.equal(collections.device_tokens.docs[0].enabled,false);
 assert.equal(collections.referral_codes.docs[0].status,'DISABLED');
 assert.equal(collections.referral_codes.docs[0].code,'ARCHaaaaaaaaaaaaaaaa');
 assert.equal(booking.customerId,user._id);
});
test('không đóng nếu còn chuyến đang chạy',async()=>{
 const user=u(),{db}=dbFor(user,{bookings:[{customerId:user._id,status:'IN_PROGRESS'}]});
 await assert.rejects(lifecycle.softDeleteCustomer(db,user),e=>e.code==='ACTIVE_BOOKING');
 assert.equal(user.status,'ACTIVE');
});
test('không đóng nếu đơn hàng chưa hoàn tất',async()=>{
 const user=u(),{db}=dbFor(user,{orders:[{customerId:user._id,status:'READY_FOR_PICKUP'}]});
 await assert.rejects(lifecycle.softDeleteCustomer(db,user),e=>e.code==='ACTIVE_ORDER');
});
test('không đóng khi ví còn tiền',async()=>{
 const user=u(),{db}=dbFor(user,{wallets:[{userId:user._id,availableBalance:20000}]});
 await assert.rejects(lifecycle.softDeleteCustomer(db,user),e=>e.code==='UNSETTLED_WALLET');
});
test('không đóng khi đang hoàn tiền',async()=>{
 const user=u(),{db}=dbFor(user,{payments:[{userId:user._id,status:'REFUND_PENDING'}]});
 await assert.rejects(lifecycle.softDeleteCustomer(db,user),e=>e.code==='PENDING_PAYMENT');
});
test('không cho tài khoản bị khóa dùng quy trình xóa để vượt khóa',async()=>{
 const user={...u(),status:'BLOCKED'}, {db}=dbFor(user);
 await assert.rejects(lifecycle.softDeleteCustomer(db,user),e=>e.code==='ACCOUNT_BLOCKED');
});
test('tự hoàn tất xóa mềm kiểu cũ status DELETED và điện thoại vẫn giữ',async()=>{
 const user={...u(),status:'DELETED'}, {db}=dbFor(user);
 assert.equal(await lifecycle.releaseLegacyDeletedPhone(db,'0901234567'),true);
 assert.equal(user.phone,'DELETED_'+String(user._id));
 assert.equal(await lifecycle.releaseLegacyDeletedPhone(db,'0901234567'),false);
});
test('xóa lại tài khoản đã DELETED là idempotent, không mở lại',async()=>{
 const user=u(),{db}=dbFor(user);
 await lifecycle.softDeleteCustomer(db,user);
 await lifecycle.softDeleteCustomer(db,user);
 assert.equal(user.status,'DELETED');
});
test('mã băm số điện thoại không chứa SĐT và có tính ổn định',()=>{
 const h=lifecycle.deletedPhoneHash('0901234567');
 assert.match(h,/^[0-9a-f]{64}$/);assert.equal(h,lifecycle.deletedPhoneHash('0901234567'));assert.ok(!h.includes('0901234567'));
});
test('không sửa logic global OTP; chỉ bỏ OTP cho số đã xóa',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../src/auth_routes.js'),'utf8');
 assert.match(src,/!wasPreviouslyDeleted && \(await getAppFeatureSettings\(db\)\)\.otpVerificationEnabled/);
 assert.match(src,/const result = await users\.insertOne\(doc\)/);
 assert.doesNotMatch(src.slice(src.indexOf("    '/register',"),src.indexOf("    '/login',")),/if \(user\) \{\s*await db\s*\.collection\('users'\)/);
});
