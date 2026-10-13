const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertLatLon,
  normalizeSearchResults,
  normalizeRoute,
  createFallbackRoute,
} = require('../src/map_service');

test('assertLatLon rejects invalid coordinates', () => {
  assert.throws(() => assertLatLon(91, 106), /latitude/i);
  assert.throws(() => assertLatLon(10.8, 181), /longitude/i);
});

test('normalizeSearchResults returns stable application fields', () => {
  const result = normalizeSearchResults([
    {
      place_id: 123,
      display_name: 'Chợ Bến Thành, Quận 1, TP.HCM',
      lat: '10.772',
      lon: '106.698',
      name: 'Chợ Bến Thành',
      type: 'marketplace',
      address: { road: 'Lê Lợi', city: 'Hồ Chí Minh' },
    },
  ]);
  assert.deepEqual(result[0], {
    placeId: 'osm:123',
    name: 'Chợ Bến Thành',
    address: 'Chợ Bến Thành, Quận 1, TP.HCM',
    latitude: 10.772,
    longitude: 106.698,
    type: 'marketplace',
  });
});

test('normalizeRoute converts OSRM geometry and metrics', () => {
  const route = normalizeRoute({
    routes: [{
      distance: 4200.4,
      duration: 780.2,
      geometry: { coordinates: [[106.69, 10.77], [106.70, 10.78]] },
    }],
  });
  assert.equal(route.distanceMeters, 4200);
  assert.equal(route.durationSeconds, 780);
  assert.deepEqual(route.polylinePoints[0], { latitude: 10.77, longitude: 106.69 });
  assert.equal(route.isFallback, false);
});

test('createFallbackRoute returns direct route with positive estimates', () => {
  const route = createFallbackRoute(10.77, 106.69, 10.80, 106.72);
  assert.ok(route.distanceMeters > 0);
  assert.ok(route.durationSeconds > 0);
  assert.equal(route.polylinePoints.length, 2);
  assert.equal(route.isFallback, true);
});
