'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMapService } = require('../src/map_service');
const suggestion = { ref_id:'auto:test-123', name:'120/9 Lê Văn Quới', display:'120/9 Lê Văn Quới, TP HCM' };
function setup({ status=200, response=[suggestion], options={} }={}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url));
    return {ok:status>=200 && status<300,status,json:async()=>response};
  };
  return { calls, service: createMapService({vietMapKey:'TEST_KEY',fetchImpl,...options}) };
}
test('search uses VietMap only despite old OSM env flags',async()=>{
 const t=setup({options:{searchProvider:'OSM',fallbackToOsm:true}});
 const rows=await t.service.search('120/9 Lê Văn Quới',{clientVersion:2});
 assert.equal(rows.length,1);
 assert.equal(rows[0].provider,'VIETMAP');
 assert.equal(t.calls.length,1);
 assert.equal(t.calls[0].hostname,'maps.vietmap.vn');
 assert.equal(t.calls[0].pathname,'/api/autocomplete/v4');
 assert.equal(t.service.publicConfig().geocodingProvider,'VIETMAP');
 assert.equal(t.service.publicConfig().osmFallbackEnabled,false);
 assert.equal(t.service.publicConfig().searchIntegrationVersion,'VIETMAP_V4_ONLY');
});
test('old clients must upgrade; never receive OSM locations',async()=>{
 const t=setup();
 await assert.rejects(t.service.search('Lê Văn Quới',{clientVersion:1}), e=>e.code==='APP_UPDATE_REQUIRED');
 assert.equal(t.calls.length,0);
});
test('no VietMap key gives explicit error, no fallback',async()=>{
 const t=setup({options:{vietMapKey:'',searchProvider:'OSM',fallbackToOsm:true}});
 await assert.rejects(t.service.search('Lê Văn Quới',{clientVersion:2}), e=>e.code==='VIETMAP_NOT_CONFIGURED');
 assert.equal(t.calls.length,0);
});
test('quota error never touches Nominatim',async()=>{
 const t=setup({status:423,options:{fallbackToOsm:true}});
 await assert.rejects(t.service.search('Lê Văn Quới',{clientVersion:2}), e=>e.code==='VIETMAP_UNAVAILABLE'&&e.httpStatus===423);
 assert.equal(t.calls.length,1);
 assert.equal(t.calls[0].hostname,'maps.vietmap.vn');
});
test('zero search suggestions does not invoke fallback',async()=>{
 const t=setup({response:[]});
 assert.deepEqual(await t.service.search('120/9 Lê Văn Quới',{clientVersion:2}),[]);
 assert.equal(t.calls.length,1);
});
test('reverse uses only VietMap',async()=>{
 const t=setup({response:[{display:'Lê Văn Quới, Bình Tân'}],options:{searchProvider:'OSM',fallbackToOsm:true}});
 const r=await t.service.reverse(10.76,106.61);
 assert.equal(r.provider,'VIETMAP');
 assert.equal(t.calls.length,1);
 assert.equal(t.calls[0].pathname,'/api/reverse/v4');
});
test('reverse unavailable must not retry with OSM',async()=>{
 const t=setup({status:401,options:{fallbackToOsm:true}});
 await assert.rejects(t.service.reverse(10.76,106.61),e=>e.code==='VIETMAP_UNAVAILABLE');
 assert.equal(t.calls.length,1);
});
test('Place uses VietMap V4 and keeps the opaque ref ID',async()=>{
 const t=setup({response:{lat:10.762,lng:106.611,display:'120/9 Lê Văn Quới',hs_num:'120/9',street:'Lê Văn Quới'}});
 const result=await t.service.placeDetails('vietmap:auto:test-123');
 assert.equal(result.houseNumber,'120/9');
 assert.equal(t.calls[0].pathname,'/api/place/v4');
 assert.equal(t.calls[0].searchParams.get('refid'),'auto:test-123');
});
test('routing remains unchanged OSRM',async()=>{
 const t=setup({response:{routes:[{distance:1000,duration:200,geometry:{coordinates:[[106.61,10.76],[106.62,10.77]]}}]}});
 const r=await t.service.route(10.76,106.61,10.77,106.62);
 assert.ok(r.distanceMeters>0);
 assert.equal(t.calls[0].pathname.startsWith('/route/v1/'),true);
});
