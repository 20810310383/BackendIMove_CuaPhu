'use strict';
/** Regression: auto dispatch uses the same safety conditions as manual dispatch. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
class ObjectIdFake {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
}
const A = new ObjectIdFake('aaaaaaaaaaaaaaaaaaaaaaaa');
const G = new ObjectIdFake('bbbbbbbbbbbbbbbbbbbbbbbb');
const N = new ObjectIdFake('cccccccccccccccccccccccc');
function loadDispatch() {
  const module = { exports: {} };
  const code = fs.readFileSync(path.join(__dirname, '../src/dispatch_engine.js'), 'utf8');
  vm.runInNewContext(code, {
    module, exports: module.exports, Date, Math, Promise, setImmediate, setTimeout, clearTimeout,
    console: { error() {}, log() {} }, process: { env: {} },
    require(name) {
      if (name === 'mongodb') return { ObjectId: ObjectIdFake };
      if (name === 'crypto') return require('node:crypto');
      throw Error(`Unexpected ${name}`);
    },
  });
  return module.exports.createDispatchEngine;
}
function fixture({ gps = true, fallback = true, pickup = true, allowFallback = true,
  waiting = false, lockBusy = false, olderVersion = 0 } = {}) {
  const booking = {
    _id: A, bookingCode: 'IM-TEST', createdAt: new Date(), status: waiting ? 'OFFERED' : 'SEARCHING',
    pickup: pickup ? { location: { coordinates: [106.7, 10.8] } } : {},
    dispatchEngine: { version: olderVersion, currentRound: waiting ? 1 : 0,
      status: waiting ? 'WAITING' : 'QUEUED',
      roundExpiresAt: waiting ? new Date(Date.now() + 60_000) : null },
  };
  const calls = [];
  const offers = [];
  const candidates = [];
  if (gps) candidates.push({ driverId: String(G), distanceKm: 0.8, source: 'GPS', pointsBlocked: false, score: 75 });
  if (fallback) candidates.push({ driverId: String(N), distanceKm: null, source: 'NO_GPS_ADMIN', pointsBlocked: false, score: 130 });
  const collections = {
    bookings: {
      findOne: async () => booking,
      updateOne: async (query, patch) => {
        calls.push({ name: 'bookings', query, patch });
        if (lockBusy && patch.$set?.['dispatchEngine.claimToken']) return { modifiedCount: 0 };
        return { modifiedCount: 1 };
      },
    },
    dispatch_configs: { findOne: async () => null },
    booking_offers_v69: {
      find: () => ({ project: () => ({ toArray: async () => offers }) }),
      findOne: async query => query._id ? offers.find(o => String(o._id) === String(query._id)) || null : null,
      insertOne: async doc => {
        const _id = new ObjectIdFake(`${String(offers.length + 1).padStart(24, 'd')}`);
        offers.push({ ...doc, _id });return { insertedId: _id };
      },
      updateOne: async (query,patch) => { calls.push({ name:'booking_offers_v69',query,patch });return { modifiedCount: 1 }; },
      updateMany: async (query,patch) => { calls.push({ name:'booking_offers_v69',query,patch });return { modifiedCount: 1 }; },
    },
    driver_cooldowns: { findOne: async () => null },
    dispatch_rounds_v69: {
      updateOne: async (query,patch) => { calls.push({ name:'dispatch_rounds_v69',query,patch });return { modifiedCount: 1 }; },
      updateMany: async (query,patch) => { calls.push({ name:'dispatch_rounds_v69',query,patch });return { modifiedCount: 1 }; },
    },
    dispatch_events: { insertOne: async doc => { calls.push({ name:'dispatch_events',doc });return { insertedId: N }; } },
  };
  const db = { collection(name) { assert.ok(collections[name], `Unexpected collection: ${name}`);return collections[name]; } };
  const matching = {
    previewCandidates: async () => ({ candidates }),
    getMatchingPolicy: async () => ({ autoDispatchEnabled: true, allowNoGpsFallback: allowFallback }),
    emitToDriver() {},
  };
  const engine = loadDispatch()({
    getDb: () => db, getMatching: () => matching,
    notificationService: { enqueue: async () => {} },
    serializeBooking: () => ({ id: String(A) }),
  });
  return { engine, booking, calls, offers };
}
test('GPS qualified: never mixes no-GPS seed fallback into same round', async () => {
  const x = fixture();
  try {
    const result = await x.engine.dispatchBooking(A);
    assert.equal(result.candidates, 1);
    assert.equal(result.candidateSource, 'GPS');
    assert.equal(String(x.offers[0].driverId), String(G));
  } finally { x.engine.close(); }
});
test('no GPS within radius: permitted fallback does not get distance 0', async () => {
  const x = fixture({ gps: false });
  try {
    const result = await x.engine.dispatchBooking(A);
    assert.equal(result.candidateSource, 'NO_GPS_FALLBACK');
    assert.equal(x.offers.length, 1);
    assert.equal(x.offers[0].matchingSnapshot.distanceKm, null);
  } finally { x.engine.close(); }
});
test('disabling fallback blocks no-GPS seed even when it ranks first', async () => {
  const x = fixture({ gps: false, allowFallback: false });
  try { const r = await x.engine.dispatchBooking(A);assert.equal(r.waitingNextRound, true);assert.equal(x.offers.length, 0); }
  finally { x.engine.close(); }
});
test('missing pickup coordinates never dispatches fallback driver', async () => {
  const x = fixture({ gps: false, pickup: false });
  try { const r = await x.engine.dispatchBooking(A);assert.equal(r.waitingNextRound, true);assert.equal(x.offers.length, 0); }
  finally { x.engine.close(); }
});
test('lease busy prevents duplicate offers on competing workers', async () => {
  const x = fixture({ lockBusy: true });
  try { const r = await x.engine.dispatchBooking(A);assert.equal(r.skipped, true);assert.equal(x.offers.length, 0); }
  finally { x.engine.close(); }
});
test('active round is not re-issued by auto-dispatch', async () => {
  const x = fixture({ waiting: true, olderVersion: 2 });
  try { const r = await x.engine.dispatchBooking(A);assert.equal(r.reason, 'ACTIVE_ROUND_WAITING');assert.equal(x.offers.length, 0); }
  finally { x.engine.close(); }
});
test('manual retry resets old pending offers and rounds before new version', async () => {
  const x = fixture({ olderVersion: 2 });
  try {
    const r = await x.engine.dispatchBooking(A,{reset:true,adminId:'test-admin'});
    assert.equal(r.dispatchVersion, 3);
    assert.ok(x.calls.some(c => c.name==='booking_offers_v69' && c.patch?.$set?.reason==='DISPATCH_RESET'));
    assert.ok(x.calls.some(c => c.name==='dispatch_rounds_v69' && c.patch?.$set?.reason==='DISPATCH_RESET'));
  } finally { x.engine.close(); }
});

test('ranking treats null GPS as unknown, never as 0km', async () => {
  const mod = { exports: {} };
  const code = fs.readFileSync(path.join(__dirname, '../src/matching_policy.js'), 'utf8');
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Date, Math, Number, Promise,
    require: name => name === 'mongodb' ? { ObjectId: ObjectIdFake } : require(name),
  });
  const policy = mod.exports.DEFAULT_MATCHING_POLICY;
  const db = { collection(name) {
    if (name === 'bookings') return { aggregate: () => ({ toArray: async () => [] }) };
    if (name === 'driver_reward_accounts') return { find: () => ({ project: () => ({ toArray: async () => [] }) }) };
    throw Error(name);
  }};
  const rows = await mod.exports.rankMatchingCandidates({ db, policy, candidates: [
    { driver: { _id: N, rating: 5, acceptanceRate: 100 }, distanceKm: null },
    { driver: { _id: G, rating: 4, acceptanceRate: 80 }, distanceKm: 1 },
  ] });
  assert.equal(String(rows[0].driver._id), String(G));
  assert.equal(rows[1].matchingBreakdown.distance, 0);
  assert.ok(rows[0].matchingBreakdown.distance > 0);
});
