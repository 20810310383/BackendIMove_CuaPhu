const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = (name) => fs.readFileSync(path.join(__dirname,'../src',name),'utf8');
const { parseDriverHeartbeatLocation: parse } = require('../src/driver_heartbeat_payload');
test('heartbeat understands old and new Driver coordinate keys', () => {
  assert.equal(parse({lat:10.76,lng:106.67}).hasCoordinates,true);
  assert.equal(parse({latitude:10.76,longitude:106.67}).hasCoordinates,true);
  assert.equal(parse({latitude:'',longitude:''}).reason,'GPS_NOT_SENT');
  assert.equal(parse({latitude:0,longitude:0}).reason,'GPS_INVALID');
  assert.equal(parse({latitude:100,longitude:1}).reason,'GPS_INVALID');
});
test('heartbeat uses matching GPS writer with expiry and reports whether updated', () => {
  assert.match(src('server.js'), /matching\.updateLocationByContext/);
  assert.match(src('server.js'), /locationUpdated: gps\.hasCoordinates/);
});
test('geospatial query failure retains a bounded, radius-checked backup', () => {
  const code = src('matching_engine.js');
  assert.match(code, /Geo query failed; using bounded distance scan/);
  assert.match(code, /haversineKm\(pickupLat, pickupLon, lat, lon\)/);
  assert.match(code, /updatedAt: \{ \$gte: freshCutoff \}/);
});
test('Auto dispatch and Admin share persisted V69 offers and expose individual blocked reasons', () => {
  const code = src('dispatch_engine.js');
  assert.match(code, /booking_offers_v69/);
  assert.match(code, /driverChecks: perDriver/);
  assert.match(code, /DRIVER_GPS_MISSING/);
  assert.match(code, /DRIVER_GPS_STALE/);
  assert.match(code, /VEHICLE_SERVICE_NOT_APPROVED/);
});
