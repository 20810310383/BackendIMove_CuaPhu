'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMapService,
  normalizeVietMapPlace,
  normalizeVietMapSuggestions,
} = require('../src/map_service');

const validRef = 'auto:RXA_123-123';
const suggestion = { ref_id: validRef, name: '120/9 Lê Văn Quới', display: '120/9 Lê Văn Quới, TP. Hồ Chí Minh' };
function mockFetch({ status = 200, payload = [suggestion] } = {}) {
  let urls = [];
  const fetchImpl = async url => {
    urls.push(new URL(url));
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { fetchImpl, urls };
}
test('VietMap with key returns opaque suggestion and no premature coordinates', async () => {
  const t = mockFetch();
  const service = createMapService({ searchProvider: 'VIETMAP', vietMapKey: 'sample-test', fetchImpl: t.fetchImpl });
  const list = await service.search('120/9 Lê Văn Quới', {clientVersion: 2, focusLat: 10.8, focusLon: 106.6});
  assert.equal(list[0].provider, 'VIETMAP');
  assert.equal(list[0].latitude, null);
  assert.equal(list[0].placeId, `vietmap:${validRef}`);
  assert.equal(t.urls[0].pathname, '/api/autocomplete/v4');
  assert.equal(t.urls[0].searchParams.get('focus'), '10.8,106.6');
});
test('VietMap without key fails explicitly rather than silently using OSM', async () => {
  const t = mockFetch();
  const service = createMapService({ searchProvider:'VIETMAP', vietMapKey:'', fetchImpl:t.fetchImpl });
  await assert.rejects(() => service.search('120/9 Lê Văn Quới',{clientVersion:2}), e=>e.code==='VIETMAP_NOT_CONFIGURED');
  assert.equal(t.urls.length, 0);
  assert.equal(service.publicConfig().vietmapKeyConfigured, false);
  assert.equal(service.publicConfig().geocodingProvider, 'VIETMAP');
});
test('VietMap API 423 is surfaced by default, no OSM', async () => {
  const t = mockFetch({status:423});
  const service = createMapService({ searchProvider:'VIETMAP', vietMapKey:'sample-test', fetchImpl:t.fetchImpl });
  await assert.rejects(() => service.search('120/9 Lê Văn Quới',{clientVersion:2}), e=>e.code==='VIETMAP_UNAVAILABLE' && e.httpStatus===423);
  assert.equal(t.urls.length,1);
  assert.equal(service.publicConfig().osmFallbackEnabled,false);
});
test('OSM fallback explicitly opted in and can be identified', async () => {
  const urls=[];
  const fetchImpl=async url=>{
    urls.push(new URL(url));
    if (url.includes('vietmap.vn')) return {ok:false,status:423};
    return {ok:true,status:200,json:async()=>[{lat:'10.76',lon:'106.65',display_name:'Lê Văn Quới'}]};
  };
  const service=createMapService({searchProvider:'VIETMAP',vietMapKey:'sample-test',fallbackToOsm:true,fetchImpl});
  const list=await service.search('120/9 Lê Văn Quới',{clientVersion:2});
  assert.equal(list[0].provider,'OPENSTREETMAP');
  assert.equal(service.publicConfig().geocodingProvider,'VIETMAP');
  assert.equal(urls.length,2);
});
test('VietMap Place includes explicit house number and street for validation', () => {
  const place=normalizeVietMapPlace({display:'120/9 Lê Văn Quới, TP HCM', hs_num:'120/9',street:'Lê Văn Quới',lat:10.762,lng:106.611});
  assert.equal(place.houseNumber,'120/9');
  assert.equal(place.street,'Lê Văn Quới');
});
test('Suggestion without valid ref_id must be ignored',()=>{
  assert.equal(normalizeVietMapSuggestions([{display:'Lê Văn Quới',ref_id:'bad'}]).length,0);
});
test('Opaque VietMap ref_id with reserved characters is preserved for Place v4', async () => {
  const ref = 'auto:Ab/C+d=1';
  const list = normalizeVietMapSuggestions([{ ref_id:ref,display:'120/9 Lê Văn Quới' }]);
  assert.equal(list[0].placeId,`vietmap:${ref}`);
  const t=mockFetch({payload:{lat:10.8,lng:106.6,display:'120/9 Lê Văn Quới',hs_num:'120/9',street:'Đường Lê Văn Quới'}});
  const service=createMapService({ searchProvider:'VIETMAP', vietMapKey:'sample-test',fetchImpl:t.fetchImpl });
  const result=await service.placeDetails(`vietmap:${ref}`);
  assert.equal(result.houseNumber,'120/9');
  assert.equal(t.urls[0].searchParams.get('refid'),ref);
});
