const test=require('node:test');const assert=require('node:assert/strict');
const {normalizeAnalyticsTrip,normalizePaymentStatus,serviceLabel}=require('../src/analytics_service');
test('COMPLETED and PAID map to canonical success',()=>{const r=normalizeAnalyticsTrip({status:'COMPLETED',serviceCode:'CAR_4',paymentStatus:'PAID',pricing:{customerTotal:100000}});assert.equal(r.completed,true);assert.equal(r.paymentSuccessful,true);assert.equal(r.serviceCode,'CAR_4')});
test('unknown service never displays undefined',()=>assert.equal(serviceLabel({serviceCode:null},new Map()),'Không xác định'));
test('PAID is successful',()=>assert.equal(normalizePaymentStatus('PAID'),'PAID'));
