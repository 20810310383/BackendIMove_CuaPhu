const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDriverLocation, mergeDriversWithLocations } = require('../src/driver_location_service');

const NOW = new Date('2026-09-17T04:40:00.000Z');

test('normalizeDriverLocation accepts fresh GeoJSON coordinates and preserves lon/lat order', () => {
  const result = normalizeDriverLocation({
    location: { type: 'Point', coordinates: [106.7009, 10.7769] },
    updatedAt: new Date('2026-09-17T04:39:30.000Z'),
    accuracyM: 8,
  }, { now: NOW, maxAgeSeconds: 120 });

  assert.deepEqual(result, {
    latitude: 10.7769,
    longitude: 106.7009,
    locationUpdatedAt: '2026-09-17T04:39:30.000Z',
    locationAgeSeconds: 30,
    locationAccuracyM: 8,
    locationValid: true,
    locationReason: null,
  });
});

test('normalizeDriverLocation rejects Null Island coordinates', () => {
  const result = normalizeDriverLocation({
    location: { type: 'Point', coordinates: [0, 0] },
    updatedAt: new Date('2026-09-17T04:39:50.000Z'),
  }, { now: NOW, maxAgeSeconds: 120 });

  assert.equal(result.locationValid, false);
  assert.equal(result.locationReason, 'ZERO_COORDINATES');
  assert.equal(result.latitude, null);
  assert.equal(result.longitude, null);
});

test('normalizeDriverLocation rejects stale GPS', () => {
  const result = normalizeDriverLocation({
    location: { type: 'Point', coordinates: [106.7009, 10.7769] },
    updatedAt: new Date('2026-09-17T04:35:00.000Z'),
  }, { now: NOW, maxAgeSeconds: 120 });

  assert.equal(result.locationValid, false);
  assert.equal(result.locationReason, 'STALE');
  assert.equal(result.locationAgeSeconds, 300);
});

test('mergeDriversWithLocations uses driver_locations as the authoritative GPS source', () => {
  const drivers = [{
    _id: 'driver-1',
    userId: 'user-1',
    onlineStatus: 'ONLINE',
    latitude: 0,
    longitude: 0,
    updatedAt: NOW,
  }];
  const locations = [{
    driverId: 'driver-1',
    location: { type: 'Point', coordinates: [106.71, 10.78] },
    updatedAt: new Date('2026-09-17T04:39:45.000Z'),
  }];

  const [result] = mergeDriversWithLocations(drivers, locations, { now: NOW, maxAgeSeconds: 120 });
  assert.equal(result.latitude, 10.78);
  assert.equal(result.longitude, 106.71);
  assert.equal(result.locationValid, true);
  assert.equal(result.locationSource, 'driver_locations');
});

test('mergeDriversWithLocations keeps the newest GPS document when legacy duplicates exist', () => {
  const drivers = [{ _id: 'driver-1', onlineStatus: 'ONLINE' }];
  const locations = [
    { driverId: 'driver-1', location: { type: 'Point', coordinates: [106.72, 10.79] }, updatedAt: new Date('2026-09-17T04:39:55.000Z') },
    { driverId: 'driver-1', location: { type: 'Point', coordinates: [106.60, 10.60] }, updatedAt: new Date('2026-09-17T04:39:20.000Z') },
  ];
  const [result] = mergeDriversWithLocations(drivers, locations, { now: NOW, maxAgeSeconds: 120 });
  assert.equal(result.latitude, 10.79);
  assert.equal(result.longitude, 106.72);
});

test('mergeDriversWithLocations prefers a valid timestamp over a legacy document without updatedAt', () => {
  const drivers = [{ _id: 'driver-1', onlineStatus: 'ONLINE' }];
  const locations = [
    { driverId: 'driver-1', location: { type: 'Point', coordinates: [106.50, 10.50] } },
    { driverId: 'driver-1', location: { type: 'Point', coordinates: [106.73, 10.80] }, updatedAt: new Date('2026-09-17T04:39:50.000Z') },
  ];
  const [result] = mergeDriversWithLocations(drivers, locations, { now: NOW, maxAgeSeconds: 120 });
  assert.equal(result.latitude, 10.80);
  assert.equal(result.longitude, 106.73);
  assert.equal(result.locationValid, true);
});
