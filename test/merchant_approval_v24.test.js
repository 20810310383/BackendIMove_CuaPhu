'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { effectiveApproval, isMerchantApproved, approvedMerchantQuery } = require('../src/merchant_approval');
const read = f => fs.readFileSync(path.resolve(__dirname,'../src',f),'utf8');

test('new PENDING merchants are never approved by default', () => {
  assert.equal(effectiveApproval({status:'PENDING'}), 'PENDING_REVIEW');
  assert.equal(isMerchantApproved({status:'PENDING'}), false);
  assert.equal(isMerchantApproved({status:'ACTIVE',approvalStatus:'PENDING_REVIEW'}), false);
  assert.equal(isMerchantApproved({status:'ACTIVE',approvalStatus:'REJECTED'}), false);
});
test('explicit approval is independent of trading status',()=>{
  assert.equal(isMerchantApproved({status:'PAUSED',approvalStatus:'APPROVED'}), true);
  assert.equal(isMerchantApproved({status:'SUSPENDED',approvalStatus:'APPROVED'}), true);
  assert.equal(effectiveApproval({status:'ACTIVE',approvalStatus:'REJECTED'}),'REJECTED');
});
test('legacy stores already active stay compatible; legacy pending stores do not',()=>{
  assert.equal(isMerchantApproved({status:'ACTIVE'}),true);
  assert.equal(isMerchantApproved({status:'BUSY'}),true);
  assert.equal(isMerchantApproved({status:'PENDING'}),false);
  assert.equal(isMerchantApproved({status:'SUSPENDED'}),false);
});
test('public merchant query requires approved state',()=>{
  const q=approvedMerchantQuery();
  assert.ok(Array.isArray(q.$or));
  assert.ok(q.$or.some(x=>x.approvalStatus==='APPROVED'));
  assert.ok(q.$or.some(x=>x.approvalStatus?.$exists===false));
});
test('registration and merchant update do not create self approval',()=>{
  const reg=read('merchant_registration_routes.js');
  const commerce=read('commerce_routes.js');
  assert.match(reg,/approvalStatus:\s*'PENDING_REVIEW'/);
  assert.match(commerce,/MERCHANT_NOT_APPROVED/);
  assert.match(commerce,/approvedMerchantQuery\(\)/);
  assert.match(commerce,/merchants\/:id\/review'/);
  assert.match(commerce,/merchant_approval_events/);
  assert.match(commerce,/permit\('merchants.manage'\)/);
});
