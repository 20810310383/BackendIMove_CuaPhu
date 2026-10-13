const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('database repair module is reusable from startup and migration script', () => {
  const repair = read('src/database_repair.js');
  const server = read('src/server.js');
  const migrate = read('scripts/migrate_database_validators.js');
  assert.match(repair, /async function repairDatabase/);
  assert.match(repair, /normalizeBookings/);
  assert.match(repair, /normalizeDrivers/);
  assert.match(repair, /normalizeWallets/);
  assert.match(repair, /normalizeLoyalty/);
  assert.match(server, /repairDatabase\(/);
  assert.match(migrate, /repairDatabase\(/);
});

test('server repairs validators before marking MongoDB connected', () => {
  const server = read('src/server.js');
  const repairIndex = server.indexOf('await repairDatabase(');
  const connectedIndex = server.indexOf('mongoConnected = true');
  assert.ok(repairIndex >= 0, 'repairDatabase startup call missing');
  assert.ok(connectedIndex >= 0, 'mongoConnected assignment missing');
  assert.ok(repairIndex < connectedIndex, 'repair must finish before backend reports DB connected');
});

test('completion validation response exposes exact failed step and collection details', () => {
  const server = read('src/server.js');
  assert.match(server, /MONGO_VALIDATION_FAILED/);
  assert.match(server, /completionStep/);
  assert.match(server, /validationCollection/);
  assert.match(server, /validationDetails/);
});

test('database repair includes non-destructive completion write-path verification', () => {
  const repair = read('src/database_repair.js');
  assert.match(repair, /async function verifyCompletionWritePath/);
  assert.match(repair, /abortTransaction\(/);
  assert.match(repair, /wallet_transactions/);
  assert.match(repair, /loyalty_transactions/);
});
