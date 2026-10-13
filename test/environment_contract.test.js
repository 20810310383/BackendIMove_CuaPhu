const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

test('Core Backend development port is fixed at 5050', () => {
  assert.match(env, /^PORT=5050$/m);
  assert.match(env, /^LAN_DISCOVERY_PORT=5051$/m);
});

test('Core Backend development CORS includes Admin Vite', () => {
  assert.match(env, /^CORS_ORIGINS=.*(?:localhost:5173|127\.0\.0\.1:5173)/m);
});

test('OSM gateway defaults are present', () => {
  assert.match(env, /^OSM_TILE_URL=https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png$/m);
  assert.match(env, /^OSM_GEOCODING_URL=https:\/\/nominatim\.openstreetmap\.org$/m);
  assert.match(env, /^OSM_ROUTING_URL=https:\/\/router\.project-osrm\.org$/m);
});
