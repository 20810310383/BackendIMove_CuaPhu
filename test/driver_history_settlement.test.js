const test=require('node:test');const assert=require('node:assert/strict');
const {normalizeDriverTripHistory}=require('../src/driver_history_service');
test('completed booking appears while settlement pending',()=>{const rows=normalizeDriverTripHistory([{_id:'x',status:'COMPLETED',pricing:{driverNetAmount:13046},settlementV133:{status:'PENDING'}}]);assert.equal(rows[0].status,'COMPLETED');assert.equal(rows[0].settlementStatus,'PROCESSING');assert.equal(rows[0].driverNetExpected,13046)});

test('earnings summary separates posted and pending trip amounts',()=>{
  const {summarizeDriverEarnings}=require('../src/driver_history_service');
  const summary=summarizeDriverEarnings([
    {driverNetExpected:10000,postedAmount:10000,settlementStatus:'SETTLED'},
    {driverNetExpected:20000,postedAmount:0,settlementStatus:'PROCESSING'},
  ]);
  assert.equal(summary.expectedNet,30000);
  assert.equal(summary.postedAmount,10000);
  assert.equal(summary.pendingAmount,20000);
});
