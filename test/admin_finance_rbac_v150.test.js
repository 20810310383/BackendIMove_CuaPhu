const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'production_routes.js'), 'utf8');

test('finance summary accepts settlement-view permission family', () => {
  assert.match(source, /finance\/summary[^\n]*permitAny\([^\n]*settlement\.view[^\n]*settlements\.view/);
});

test('finance reconcile accepts settlement-manage permission family', () => {
  assert.match(source, /finance\/reconcile[^\n]*permitAny\([^\n]*settlement\.manage[^\n]*settlements\.manage/);
});
