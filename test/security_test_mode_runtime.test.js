const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProductionService } = require('../src/production_service');

function service() {
  return createProductionService({
    getDb: () => null,
    getMongoConnected: () => false,
    getNotifications: () => null,
    getMatching: () => null,
    getDispatch: () => null,
    getSocketServer: () => null,
  });
}

test('legacy TEST mode migrates auth gates to non-blocking defaults', () => {
  const config = service().normalizeProductionConfig({
    securityMode: 'TEST',
    securityPolicy: {},
  });
  assert.equal(config.securityPolicyVersion, 2);
  assert.equal(config.securityPolicy.enforceKyc, true);
  assert.equal(config.securityPolicy.enforceRiskRestriction, true);
  assert.equal(config.securityPolicy.requireFcm, false);
  assert.equal(config.securityPolicy.requireTrustedDevice, false);
  assert.equal(config.securityPolicy.requireIntegrity, false);
  assert.equal(config.securityPolicy.requireFace, false);
  assert.equal(config.securityPolicy.requireBiometric, false);
});

test('version 2 TEST mode preserves explicit admin choices', () => {
  const config = service().normalizeProductionConfig({
    securityMode: 'TEST',
    securityPolicyVersion: 2,
    securityPolicy: { requireFace: true, requireFcm: true, requireBiometric: true },
  });
  assert.equal(config.securityPolicy.requireFace, true);
  assert.equal(config.securityPolicy.requireFcm, true);
  assert.equal(config.securityPolicy.requireBiometric, true);
});

test('backend startup owns database repair so all start commands are safe', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.equal(pkg.scripts['migrate:v672'], 'node scripts/migrate_database_validators.js');
  assert.match(pkg.scripts.dev, /src\/server\.js/);
  assert.match(pkg.scripts.start, /src\/server\.js/);
  assert.match(server, /repairDatabase\(/);
});
