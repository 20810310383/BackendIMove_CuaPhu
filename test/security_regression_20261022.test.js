'use strict';
// Deterministic unit / source-contract tests only; full API/Mongo integration needs staging.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifiedMetrics, extractLocation } = require('../src/trusted_route_pricing');
const { buildCorsOptions } = require('../src/production_guard');
const source = name => fs.readFileSync(path.resolve(__dirname, '../src', name), 'utf8');
const origin={ latitude:10.772, longitude:106.698 };
const destination={ latitude:10.802, longitude:106.724 };

test('trusted route: backend obtains its own routing metrics', async () => {
  const calls=[];
  const mock={ route:async (...args)=>{
    calls.push(args); return {distanceMeters:5486,durationSeconds:739,isFallback:false};
  }};
  const result=await verifiedMetrics({pickup:origin,destination,routeService:mock});
  assert.deepEqual(result,{distanceKm:5.486,durationMinutes:13});
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].slice(0,4),[10.772,106.698,10.802,106.724]);
});

test('trusted route: rejects a fallback estimate instead of billing with a guess', async () => {
  await assert.rejects(
    verifiedMetrics({pickup:origin,destination,routeService:{route:async()=>({distanceMeters:6000,durationSeconds:700,isFallback:true})}}),
    error=>error.httpStatus===503 && error.code==='TRUSTED_ROUTE_UNAVAILABLE',
  );
});

test('trusted route: provider outage fails closed', async () => {
  await assert.rejects(
    verifiedMetrics({pickup:origin,destination,routeService:{route:async()=>{throw new Error('timed out');}}}),
    error=>error.httpStatus===503,
  );
});

test('trusted route: no coordinates or Null Island are not bookable', () => {
  for (const point of [null,{}, {latitude:91,longitude:106}, {latitude:0,longitude:0}]) {
    assert.throws(()=>extractLocation(point),error=>error.httpStatus===400);
  }
});

test('CORS production allows valid HTTPS subdomain pattern only', async () => {
  const prevEnv=process.env.NODE_ENV, prevAllowed=process.env.CORS_ORIGINS;
  process.env.NODE_ENV='production';
  process.env.CORS_ORIGINS='https://imove.daututh79.com,https://*.daututh79.com';
  try {
    const config=buildCorsOptions();
    const allowed=originValue=>new Promise(resolve=>config.origin(originValue,(err,ok)=>resolve(!err&&ok===true)));
    assert.equal(await allowed('https://admin.daututh79.com'),true);
    assert.equal(await allowed('https://imove.daututh79.com'),true);
    assert.equal(await allowed('https://evil-daututh79.com'),false);
    assert.equal(await allowed('https://daututh79.com.attacker.test'),false);
    assert.equal(await allowed('http://admin.daututh79.com'),false);
    assert.equal(await allowed('https://admin.daututh79.com:8443'),false);
  } finally {
    if(prevEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prevEnv;
    if(prevAllowed===undefined)delete process.env.CORS_ORIGINS;else process.env.CORS_ORIGINS=prevAllowed;
  }
});

test('source contract: fee/discount never read from client order payload', () => {
  const code=source('commerce_routes.js');
  assert.doesNotMatch(code,/Number\(req\.body\?\.discount/);
  assert.doesNotMatch(code,/Number\(req\.body\?\.serviceFee/);
  assert.match(code,/serviceFee:0,discount:0/);
});

test('source contract: Merchant state update includes previous status', () => {
  assert.match(source('commerce_routes.js'),/updateOne\(\{_id,merchantId:req\.merchantContext\.merchant\._id,status:current\.status\}/);
});

test('source contract: closed fund requests cannot be rejected or receive a new receipt', () => {
  const code=source('fund_topup_routes.js');
  assert.match(code,/TOPUP_FINALIZED/);
  assert.match(code,/TOPUP_RECEIPT_LOCKED/);
  assert.match(code,/status:'PROCESSING'/);
});

test('source contract: Admin write operations require explicit permissions', () => {
  const code=source('commerce_routes.js');
  assert.match(code,/r\.put\('\/delivery-policy',permit\('orders\.policy\.manage'\)/);
  assert.match(code,/r\.post\('\/orders\/:id\/dispatch',permit\('orders\.dispatch'\)/);
});
