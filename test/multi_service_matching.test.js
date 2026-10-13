const test=require('node:test');const assert=require('node:assert/strict');
const {driverCanServe}=require('../src/service_catalog_service');
test('CAR_7 is never offered to BIKE-only vehicle',()=>{assert.equal(driverCanServe({status:'APPROVED',serviceCodes:['BIKE']},'CAR_7'),false);assert.equal(driverCanServe({status:'APPROVED',serviceCodes:['CAR_7','MPV_7']},'CAR_7'),true)});
