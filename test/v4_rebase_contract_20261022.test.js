const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = rel => fs.readFileSync(path.join(__dirname,'..',rel),'utf8');

test('V6.9 dispatch queue recovery remains installed after security merge',()=>{
 const server=source('src/server.js');const dispatch=source('src/dispatch_engine.js');
 assert.match(server,/ensureCommerceIndexes\(nextDb\)/);
 assert.match(server,/ensureDriverExperienceIndexes\(nextDb\)/);
 assert.match(server,/ensureFundTopupIndexes\(nextDb\)/);
 assert.ok(server.indexOf('dispatchEngine.databaseReady()') < server.indexOf('matching.databaseReady()'));
 assert.match(dispatch,/resumeSearchingBookings/);
});
test('Backend v4 commerce feed remains paginated after security merge',()=>{
 const file=source('src/commerce_routes.js');
 assert.match(file,/COMMERCE_SERVICE_CODES = \['FOOD','ERRAND','DELIVERY'\]/);
 assert.match(file,/\.skip\(\(page-1\)\*limit\)/);
 assert.match(file,/hasNext,hasPrevious:page>1/);
 assert.match(file,/orders\.policy\.manage/);
 assert.match(file,/orders\.dispatch/);
});
test('Funds have safe state transitions and paginated admin review',()=>{
 const file=source('src/fund_topup_routes.js');
 assert.match(file,/status:'PROCESSING'/);
 assert.match(file,/code:'TOPUP_ALREADY_PROCESSING'/);
 assert.match(file,/code:'TOPUP_FINALIZED'/);
 assert.match(file,/\.skip\(\(page-1\)\*limit\)/);
 assert.match(file,/hasNext:rows\.length>limit/);
});
test('RBAC registry, role seed and default roles include explicit commerce write rights',()=>{
 const file=source('src/admin_console_routes.js');
 assert.match(file,/orders\.dispatch/);
 assert.match(file,/orders\.policy\.manage/);
 assert.match(file,/code==='SUPER_ADMIN'/);
});
test('Auth rejects admin with no role code; does not grant implicit superadmin',()=>{
 const file=source('src/admin_guard.js');
 assert.match(file,/if \(!codes\.length\) return null/);
 assert.doesNotMatch(file,/!codes\.length \|\| codes\.includes\('SUPER_ADMIN'\)/);
 assert.match(file,/const pendingAdminContexts/);
});
test('No client money fields trusted, commerce orders are idempotent',()=>{
 const file=source('src/commerce_routes.js');
 assert.match(file,/serviceFee:0,discount:0/);
 assert.match(file,/verifiedMetrics\(\{pickup:req\.body\?\.pickup,destination:req\.body\?\.destination\}\)/);
 assert.match(file,/Idempotency-Key|idempotency-key/);
 assert.match(source('scripts/migrate_commerce_schema.js'),/uq_order_idempotency/);
});
test('Security merge leaves HTTPS origin-only CORS wildcard matching',()=>{
 const file=source('src/production_guard.js');
 assert.match(file,/parsed\.protocol === 'https:'/);
 assert.match(file,/parsed\.hostname\.toLowerCase\(\)\.endsWith/);
});
test('Admin UI displays next/previous pages from Backend v4',(t)=>{
 const root=path.join(__dirname,'..','..','AdminIMove_CuaPhu','src');
 if(!fs.existsSync(root)){t.skip('Admin source is distributed in the full 5-app package');return;}
 const commerce=fs.readFileSync(path.join(root,'CommerceOrdersPage.jsx'),'utf8');
 const funds=fs.readFileSync(path.join(root,'FundTransferSettingsPanel.jsx'),'utf8');
 assert.match(commerce,/q\.set\('page',String\(page\)\)/);
 assert.match(commerce,/hasNext/);
 assert.match(funds,/&page=\$\{page\}&limit=50/);
});
