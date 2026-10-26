const fs=require('fs');const path=require('path');
const server=path.resolve(__dirname,'../src/server.js');
const dry=process.argv.includes('--check');
let s=fs.readFileSync(server,'utf8');
const imports="const { createReferralRouter, createReferralAdminRouter } = require('./referral_routes');\nconst { createDriverPointLedgerAdminRouter } = require('./driver_point_ledger_routes');";
const mount="app.use('/api/v189/referrals/:app', createReferralRouter({getDb:()=>db}));\napp.use('/api/v189/admin/referrals', createReferralAdminRouter({getDb:()=>db}));\napp.use('/api/v189/admin/points', createDriverPointLedgerAdminRouter({getDb:()=>db}));";
const marker="const { createPromotionService } = require('./promotion_service');";
const routeAnchor="app.use('/api/promotions', createPromotionCustomerRouter({ getPromotion:()=>promotionService, requireCustomer }));";
if(!s.includes(marker)||!s.includes(routeAnchor))throw Error('Backend server.js không khớp bản (5): không tự ghép để tránh phá dispatch.');
if(!s.includes("require('./referral_routes')"))s=s.replace(marker,imports+'\n'+marker);
if(!s.includes("app.use('/api/v189/admin/referrals'"))s=s.replace(routeAnchor,routeAnchor+'\n'+mount);
if(!s.includes("app.use('/api/v189/admin/points'"))s=s.replace(routeAnchor,routeAnchor+'\n'+"app.use('/api/v189/admin/points', createDriverPointLedgerAdminRouter({getDb:()=>db}));");
if(dry){console.log('[CHECK] Có thể ghép Backend, sẽ không ghi đè các sửa Auto Dispatch.');process.exit(0)}
const b=server+'.referrals-backup-'+Date.now();fs.copyFileSync(server,b);fs.writeFileSync(server,s);console.log('Đã ghép API referrals và point ledger. Backup:',b);
