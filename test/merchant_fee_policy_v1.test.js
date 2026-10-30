'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeRules,calculateMerchantFees,intVnd}=require('../src/merchant_fee_policy');
const rules=normalizeRules([
  {id:'platform',name:'Phí nền tảng',method:'PERCENT',value:15,enabled:true},
  {id:'payment',name:'Phí thanh toán',method:'PERCENT',value:1.5,enabled:true},
  {id:'fixed',name:'Phí xử lý',method:'FIXED',value:500,enabled:true}
]);
test('VND subtotal 20,000 gives expected net 16,200',()=>{
 const s=calculateMerchantFees({subtotal:20000,merchantId:'507f1f77bcf86cd799439011',config:{revision:1,rules}});
 assert.equal(s.grossAmount,20000);assert.equal(s.feeTotal,3800);assert.equal(s.netAmount,16200);
 assert.deepEqual(s.fees.map(f=>f.amount),[3000,300,500]);
});
test('fixed charge applies once per order, not per item',()=>{
 const s=calculateMerchantFees({subtotal:60000,merchantId:'x',config:{rules}});
 assert.equal(s.fees[2].amount,500);
});
test('merchant scoped rules apply only to named merchant',()=>{
 const config={rules:normalizeRules([{id:'special',name:'Phí riêng',method:'FIXED',value:1000,merchantId:'507f1f77bcf86cd799439011'}])};
 assert.equal(calculateMerchantFees({subtotal:20000,merchantId:'other',config}).feeTotal,0);
 assert.equal(calculateMerchantFees({subtotal:20000,merchantId:'507f1f77bcf86cd799439011',config}).feeTotal,1000);
});
test('fixed charges cannot produce negative payout',()=>{
 const config={rules:normalizeRules([{id:'x',name:'Phí cố định',method:'FIXED',value:5000}])};
 const s=calculateMerchantFees({subtotal:1000,merchantId:'m',config});
 assert.equal(s.netAmount,0);assert.equal(s.feeTotal,1000);assert.equal(s.fees[0].calculatedAmount,5000);assert.equal(s.hasCappedFees,true);
});
test('empty config charges no fee',()=>{
 const s=calculateMerchantFees({subtotal:20000,merchantId:'x',config:{rules:[]}});
 assert.equal(s.netAmount,20000);
});
test('blocks invalid admin rules',()=>{
 assert.throws(()=>normalizeRules([{id:'x',name:'Bad',method:'PERCENT',value:101}]));
 assert.throws(()=>normalizeRules([{id:'x',name:'A',method:'FIXED',value:1},{id:'x',name:'B',method:'FIXED',value:1}]));
 assert.throws(()=>normalizeRules([{id:'hack',name:'x',method:'FIXED',value:-2}]));
 assert.equal(normalizeRules([{id:'safe',name:'Phí',method:'PERCENT',value:0.29}])[0].value,0.29);
});
test('subtotals must be nonnegative integer VND',()=>{
 assert.throws(()=>intVnd(1200.5));assert.throws(()=>intVnd(-1));assert.equal(intVnd(15000),15000);
});
