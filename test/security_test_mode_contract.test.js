const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('production config supports securityMode and securityPolicy', () => {
  const source = read('src/production_service.js');
  assert.match(source, /securityMode:\s*'PRODUCTION'/);
  assert.match(source, /securityPolicy:\s*\{/);
  assert.match(source, /requireFcm/);
  assert.match(source, /requireTrustedDevice/);
  assert.match(source, /requireIntegrity/);
  assert.match(source, /requireFace/);
  assert.match(source, /enforceRiskRestriction/);
});

test('trust router can read runtime production config for app integrity enforcement', () => {
  const source = read('src/trust_routes.js');
  assert.match(source, /getProduction/);
  assert.match(source, /loadProductionConfig\(/);
  assert.match(source, /securityPolicy\?\.requireIntegrity/);
});
