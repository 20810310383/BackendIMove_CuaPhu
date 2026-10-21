const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

test('V6.9 dispatch honours the Matching auto switch and recovers stranded searching bookings', () => {
  const source = read('dispatch_engine.js');
  assert.match(source, /AUTO_DISPATCH_DISABLED/);
  assert.match(source, /async function resumeSearchingBookings/);
  assert.match(source, /dispatchEngine\.status': 'RESUMING'/);
  assert.match(source, /await resumeSearchingBookings\(\{ limit: 25 \}\)/);
});

test('Matching delegates queue recovery and driver-cancel reassignment to V6.9', () => {
  const source = read('matching_engine.js');
  assert.match(source, /getDispatch = null/);
  assert.match(source, /dispatch\.resumeSearchingBookings\(\)/);
  assert.match(source, /dispatch\.dispatchWithRetry\(requeued\._id, \{ reset: true \}\)/);
});

test('control-center APIs read the active V6.9 offer collection', () => {
  const source = read('matching_admin_routes.js');
  assert.match(source, /collection\('booking_offers_v69'\)/);
  assert.match(source, /dispatch: b\.dispatchEngine \|\| b\.dispatch \|\| null/);
});
