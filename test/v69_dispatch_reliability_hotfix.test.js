'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
class TestObjectId {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
}
function loadEngine() {
  const module = { exports: {} };
  vm.runInNewContext(src('dispatch_engine.js'), {
    module, exports: module.exports, process: { env: {} }, Date, Math, Promise,
    console: { error() {}, log() {} }, setTimeout, clearTimeout, setImmediate,
    require(name) {
      if (name === 'mongodb') return { ObjectId: TestObjectId };
      if (name === 'crypto') return require('node:crypto');
      throw new Error(`Unexpected import ${name}`);
    },
  }, { filename: 'dispatch_engine.js' });
  return module.exports.createDispatchEngine;
}
function fakeDbFixture({ candidates = [], failNotification = false, failSocket = false } = {}) {
  const bookingId = new TestObjectId('aaaaaaaaaaaaaaaaaaaaaaaa');
  const driverId = new TestObjectId('bbbbbbbbbbbbbbbbbbbbbbbb');
  const booking = {
    _id: bookingId, bookingCode: 'TEST-001', status: 'SEARCHING', serviceCode: 'BIKE',
    createdAt: new Date(), driverId: null, dispatchEngine: { status: 'QUEUED' },
  };
  const calls = [];
  const offers = [];
  const collections = {
    bookings: {
      findOne: async () => booking,
      updateOne: async (q, patch) => { calls.push({ collection: 'bookings', q, patch }); return { modifiedCount: 1 }; },
    },
    dispatch_configs: { findOne: async () => null },
    booking_offers_v69: {
      find: () => ({ project: () => ({ toArray: async () => offers }) }),
      findOne: async (q) => {
        if (q._id) return offers.find(x => String(x._id) === String(q._id)) || null;
        return null;
      },
      insertOne: async (doc) => {
        const _id = new TestObjectId('cccccccccccccccccccccccc');
        offers.push({ ...doc, _id }); return { insertedId: _id };
      },
      updateOne: async (q, patch) => { calls.push({ collection: 'booking_offers_v69', q, patch }); return { modifiedCount: 1 }; },
    },
    driver_cooldowns: { findOne: async () => null },
    dispatch_rounds_v69: { updateOne: async () => ({ modifiedCount: 1 }) },
    dispatch_events: { insertOne: async () => ({ insertedId: new TestObjectId('dddddddddddddddddddddddd') }) },
  };
  const db = { collection(name) { if (!collections[name]) throw new Error('Unexpected collection '+name); return collections[name]; } };
  const matching = {
    getMatchingPolicy: async () => ({ autoDispatchEnabled: true, allowNoGpsFallback: false }),
    previewCandidates: async () => ({ candidates }),
    emitToDriver() { if (failSocket) throw Error('SOCKET_DOWN'); },
  };
  const engine = loadEngine()({
    getDb: () => db, getMatching: () => matching,
    notificationService: { enqueue: async () => { if (failNotification) throw Error('NOTIFICATION_DOWN'); } },
    serializeBooking: (doc) => ({ id: String(doc._id) }), addEvent: async () => {},
  });
  return { engine, bookingId, driverId, calls, offers };
}

test('No candidates preserves durable nextRetryAt rather than clearing after dispatchWithRetry', async () => {
  const f = fakeDbFixture();
  const result = await f.engine.dispatchWithRetry(f.bookingId, { reset: true });
  assert.equal(result.waitingNextRound, true);
  const pending = f.calls.find(x => x.patch?.$set?.['dispatchEngine.status'] === 'WAITING_NEXT_ROUND');
  assert.ok(pending);
  assert.ok(pending.patch.$set['dispatchEngine.nextRetryAt'] instanceof Date);
  assert.equal(f.calls.filter(x => x.patch?.$unset?.['dispatchEngine.nextRetryAt'] !== undefined).length, 0);
  f.engine.close();
});

test('Offer persists and round finishes despite socket and notification outage', async () => {
  const driverId = new TestObjectId('bbbbbbbbbbbbbbbbbbbbbbbb');
  const f = fakeDbFixture({
    candidates: [{ driverId: String(driverId), pointsBlocked: false, distanceKm: 1, score: 100, rank: 1 }],
    failSocket: true, failNotification: true,
  });
  const result = await f.engine.dispatchWithRetry(f.bookingId, { reset: true });
  assert.equal(result.candidates, 1);
  assert.equal(f.offers.length, 1);
  assert.equal(f.offers[0].status, 'PENDING');
  assert.ok(f.calls.some(x => x.patch?.$set?.status === 'OFFERED'));
  assert.ok(f.calls.some(x => String(x.patch?.$set?.['notification.lastError'] || '').includes('NOTIFICATION_DOWN')));
  f.engine.close();
});

test('Recovery scans stranded RESUMING state and persisted retry due time', () => {
  const code = src('dispatch_engine.js');
  assert.match(code, /\['RETRYING', 'RESUMING'\]/);
  assert.match(code, /'dispatchEngine.nextRetryAt': \{ \$lte: now \}/);
});

test('Commerce ready dispatch gets unique notification dedupe key on each retry', async () => {
  const code = src('commerce_routes.js');
  const begin = code.indexOf('async function dispatchCommerceReady(');
  const end = code.indexOf('\nasync function assignCommerceDriver(', begin);
  assert.ok(begin >= 0 && end > begin);
  const notifications = [];
  let dispatchAttempt = 0;
  const db = { collection(name) {
    assert.equal(name, 'orders');
    return {
      updateOne: async () => { dispatchAttempt++; return { modifiedCount: 1 }; },
      findOne: async () => ({ dispatchAttempt }),
    };
  } };
  const driverId = new TestObjectId('bbbbbbbbbbbbbbbbbbbbbbbb');
  const context = {
    eligibleCommerceDrivers: async () => [{ _id: driverId }],
    Date, Promise,
  };
  const dispatchFn = vm.runInNewContext(`(()=>{${code.slice(begin, end)};return dispatchCommerceReady;})()`, context);
  const order = { _id: new TestObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'), status: 'CREATED', serviceCode: 'ERRAND', merchantId: null, driverId: null };
  const notificationService = { enqueue: async (doc) => { notifications.push(doc.dedupeKey); } };
  await dispatchFn({ db, order, notificationService });
  await dispatchFn({ db, order, notificationService });
  assert.equal(notifications.length, 2);
  assert.notEqual(notifications[0], notifications[1]);
});

test('Commerce worker recovers orphaned CREATED ERRAND orders without merchant', () => {
  const code = src('commerce_routes.js');
  const begin = code.indexOf('function createCommerceDispatchWorker(');
  const end = code.indexOf('\nmodule.exports=', begin);
  assert.ok(begin >= 0 && end > begin);
  assert.match(code.slice(begin, end), /serviceCode:'ERRAND',merchantId:null,status:'CREATED'/);
  assert.match(code.slice(begin, end), /dispatchStartedAt.*<60000/);
});
