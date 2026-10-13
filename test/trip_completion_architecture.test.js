const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('core completion transaction does not write loyalty or wallet settlement', () => {
  const source = read('src/platform_service.js');
  const start = source.indexOf('async function completeBookingTransaction');
  const end = source.indexOf('// ----------------------- V6.0: ride recovery', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /awardBookingPoints\(/);
  assert.doesNotMatch(block, /addWalletTransaction\(/);
  assert.match(block, /BOOKING_COMMIT/);
  assert.match(block, /DRIVER_RELEASE/);
});

test('completed booking settlement exposes idempotent retry stages', () => {
  const source = read('src/platform_service.js');
  assert.match(source, /async function reconcileCompletedBookingSettlement/);
  assert.match(source, /LOYALTY_SETTLEMENT/);
  assert.match(source, /DRIVER_EARNING/);
  assert.match(source, /SETTLED|PARTIAL|FAILED/);
});

test('admin reconcile retries both app settlement and platform ledger', () => {
  const routes = read('src/production_routes.js');
  assert.match(routes, /getPlatform/);
  assert.match(routes, /reconcileCompletedBookingSettlement/);
  assert.match(routes, /postSettlement/);
});

test('completion API never returns UNKNOWN step', () => {
  const server = read('src/server.js');
  const start = server.indexOf("app.post('/api/bookings/:id/status'");
  const end = server.indexOf("app.post('/api/bookings/:id/cancel'", start);
  assert.ok(start >= 0 && end > start);
  const route = server.slice(start, end);
  assert.doesNotMatch(route, /UNKNOWN/);
  assert.match(route, /BOOKING_COMMIT|DRIVER_RELEASE|BOOKING_VALIDATION/);
});
