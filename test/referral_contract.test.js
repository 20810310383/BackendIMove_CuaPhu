const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=n=>fs.readFileSync(path.join(root,n),'utf8');
// These are static contract checks and must not be represented as integration tests.
test('referral app source is obtained from authenticated route',()=>{
 const s=read('src/referral_routes.js');
 assert.match(s,/req\.params\.app/);assert.match(s,/jwt\.verify/);
 assert.match(s,/sourceApp:req\.referralSource/);
 assert.match(s,/mergeParams:true/);
});
test('reject self-referral and repeated application',()=>{
 const s=read('src/referral_routes.js');assert.match(s,/owner\.ownerUserId/);
 assert.match(s,/usedByUserId:1.*unique:true/);assert.match(s,/code:1.*unique:true/);
});
test('reward is conditional and issued in transaction once',()=>{
 const s=read('src/referral_routes.js');
 assert.match(s,/session\.withTransaction/);
 assert.match(s,/referral_rewards/);assert.match(s,/redemptionId:1.*unique:true/);
 assert.match(s,/status:'COMPLETED'/);
});
test('admin driver point debit prevents negative balance atomically',()=>{
 const s=read('src/driver_points_service.js');
 assert.match(s,/balance:\{\$gte:-delta\}/);assert.match(s,/session\.withTransaction/);
 assert.match(s,/sourceTransactionId/);
});
test('point writes require finance permission',()=>{
 const s=read('src/driver_experience_routes.js');
 assert.match(s,/point-adjustments', pointWriteGuard\.requireAdmin, pointWriteGuard\.permit\('payments\.manage'\)/);
 const referral=read('src/referral_routes.js');
 assert.match(referral,/Thưởng điểm cần quyền payments\.manage/);
});
test('dispatch patch preserved',()=>{
 const s=read('src/matching_engine.js');const d=read('src/dispatch_engine.js');
 assert.match(s,/emitToDriver/);assert.match(d,/emitToDriver/);
});
test('server mounts referral & ledger routers',()=>{
 const s=read('src/server.js');assert.match(s,/api\/v189\/referrals/);
 assert.match(s,/api\/v189\/admin\/referrals/);assert.match(s,/api\/v189\/admin\/points/);
});
