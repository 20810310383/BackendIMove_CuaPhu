'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

// Keeps the regression test runnable offline without installing dependencies.
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'express') return {
    Router() {
      const routes = { GET: null, PUT: null };
      return {
        routes,
        use() {},
        get(_path, ...handlers) { routes.GET = handlers[handlers.length - 1]; },
        put(_path, ...handlers) { routes.PUT = handlers[handlers.length - 1]; },
      };
    },
  };
  if (request === './admin_guard') return {
    createAdminGuard: () => ({ requireAdmin() {}, permit: () => () => {} }),
  };
  return originalLoad(request, parent, isMain);
};
const legal = require('../src/legal_routes');
Module._load = originalLoad;

const rows = new Map();
const fakeDb = {
  collection(name) {
    if (!rows.has(name)) rows.set(name, new Map());
    const table = rows.get(name);
    return {
      async findOne(query) { return table.get(query._id) || null; },
      async updateOne(query, update) { table.set(query._id, { ...(table.get(query._id) || {}), ...update.$set }); },
      async insertOne(_row) {},
    };
  },
};
function response() {
  return {
    statusCode: 200, payload: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}
const admin = legal.createLegalAdminRouter({ getDb: () => fakeDb });
const publicApi = legal.createLegalPublicRouter({ getDb: () => fakeDb });
const rich = (text, attrs = {}) => [{ type: 'h2', runs: [{ text, ...attrs }] }];

async function put(app, text, enabled = true) {
  const res = response();
  await admin.routes.PUT({ query: { app }, body: {
    app, termsTitle: 'Terms ' + app, privacyTitle: 'Privacy ' + app,
    termsRich: rich(text, { bold: true }), privacyRich: rich('Privacy policy applies only to ' + app),
    version: '2.0', enabled,
  }, admin: { _id: 'test-admin' } }, res);
  return res;
}
async function get(app, router = publicApi) {
  const res = response();
  await router.routes.GET({ query: { app } }, res);
  return res;
}

test('Three legal documents are isolated and independently published in MongoDB', async () => {
  for (const app of legal.APP_IDS) {
    const result = await put(app, `Legal rules for ${app} account, not the other apps.`, app !== 'DRIVER');
    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.legal.app, app);
  }
  for (const app of legal.APP_IDS) {
    const result = await get(app);
    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.legal.app, app);
    assert.ok(result.payload.legal.termsContent.includes(app));
    assert.equal(result.payload.legal.enabled, app !== 'DRIVER');
    assert.equal(result.payload.legal.termsRich[0].runs[0].bold, true);
  }
  assert.ok(rows.get('app_legal_settings').has('LEGAL_USER'));
  assert.ok(rows.get('app_legal_settings').has('LEGAL_DRIVER'));
  assert.ok(rows.get('app_legal_settings').has('LEGAL_MERCHANT'));
});

test('Invalid app ID is rejected, and unsafe inline links are discarded', async () => {
  assert.equal((await get('ADMIN')).statusCode, 400);
  const dirty = legal.normalizeRich([{ type: 'paragraph', runs: [
    { text: 'Safe text', bold: true, href: 'javascript:alert(1)' },
    { text: ' OK', href: 'https://imove.example.com/safety' },
  ] }, { type: 'script', runs: [{ text: 'should be stripped' }] }]);
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].runs[0].href, undefined);
  assert.equal(dirty[0].runs[0].bold, true);
  assert.ok(dirty[0].runs[1].href.startsWith('https:'));
});

test('Can publish Terms first, then complete Privacy later', async () => {
  const res = response();
  await admin.routes.PUT({ query: { app: 'DRIVER' }, body: {
    termsTitle: 'Driver Terms', privacyTitle: 'Driver Privacy',
    termsRich: [{ type: 'paragraph', align: 'center', runs: [{ text: 'Driver-specific terms sufficiently long', bold: true, color: '#e71939' }] }],
    privacyRich: [], version: '2.1', enabled: true,
  }, admin: { _id: 'admin' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.legal.termsRich[0].align, 'center');
  assert.equal(res.payload.legal.termsRich[0].runs[0].color, '#e71939');
  assert.equal(res.payload.legal.privacyContent, '');
  assert.equal(res.payload.legal.enabled, true);
});

test('Old shared legal remains visible until each new app-specific document is saved', async () => {
  const m = rows.get('app_legal_settings');
  m.set('PUBLIC_LEGAL', {
    termsContent: 'Old general terms for all three apps',
    privacyContent: 'Old general privacy policy text',
    version: '1.0',
  });
  m.delete('LEGAL_MERCHANT');
  const res = await get('MERCHANT');
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.legal.app, 'MERCHANT');
  assert.equal(res.payload.legal.termsContent, 'Old general terms for all three apps');
  assert.ok(m.get('PUBLIC_LEGAL')); // Migration never mutates old shared document.
});

test('Admin and three Flutter clients address their own legal documents', () => {
  const root = path.resolve(__dirname, '../..');
  const page = fs.readFileSync(path.join(root, 'AdminIMove_CuaPhu/src/LegalSettingsPage.jsx'), 'utf8');
  assert.ok(page.includes('LegalRichEditor'));
  assert.ok(page.includes('USER'));
  assert.ok(page.includes('DRIVER'));
  assert.ok(page.includes('MERCHANT'));
  for (const app of legal.APP_IDS) {
    const svc = fs.readFileSync(path.join(root, app === 'USER' ? 'User' : app === 'DRIVER' ? 'Driver' : 'Merchant', 'lib/services/legal_service.dart'), 'utf8');
    assert.ok(svc.includes(`?app=${app}`), app);
  }
});
