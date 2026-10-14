
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = path.join(__dirname,'../..');
const read = p => fs.readFileSync(path.join(base,p),'utf8');
test('Admin không tự điền số tài khoản mặc định', () => {
  const app = read('AdminIMove_CuaPhu/src/App.jsx');
  assert.ok(app.includes("const [login,setLogin]=React.useState('')"));
  assert.ok(!app.includes("React.useState('0909000099')"));
});
test('OTP xuất hiện trong Security Test Mode Center và cập nhật app settings', () => {
  const sec = read('AdminIMove_CuaPhu/src/ProductionHealthPage.jsx');
  const panel = read('AdminIMove_CuaPhu/src/RegistrationOtpPanel.jsx');
  assert.ok(sec.includes('<RegistrationOtpPanel access={access} />'));
  assert.ok(panel.includes('otpVerificationEnabled: enabled'));
  assert.ok(panel.includes('/api/v180/admin/app-settings'));
});
test('Production được bật/tắt từng điều kiện mà không reset về true', () => {
  const sec = read('AdminIMove_CuaPhu/src/ProductionHealthPage.jsx');
  assert.ok(sec.includes('withSecurityMode(config, mode)'));
  assert.ok(!sec.includes('forceProductionPolicy'));
  assert.ok(!sec.includes('disabledByMode = !testMode'));
  assert.ok(sec.includes('securityPolicy: { ...policy, [key]: checked }'));
});

test('Backend giữ nguyên các công tắc tắt khi Production, kể cả sau khi lưu', async () => {
  const { createProductionService } = require('../src/production_service');
  const storage = new Map();
  const db = {
    collection(name) {
      assert.equal(name, 'app_settings');
      return {
        async findOne(q) { return storage.get(q.key) || null; },
        async updateOne(q, update) {
          storage.set(q.key, { key: q.key, value: update.$set.value });
        },
      };
    },
  };
  const service = createProductionService({getDb:()=>db});
  const saved = await service.saveProductionConfig({
    securityMode: 'PRODUCTION',
    securityPolicyVersion: 2,
    securityPolicy: { requireFcm: false, requireFace: false, enforceKyc: false },
  });
  assert.equal(saved.securityMode, 'PRODUCTION');
  assert.equal(saved.securityPolicy.requireFcm, false);
  assert.equal(saved.securityPolicy.requireFace, false);
  assert.equal(saved.securityPolicy.enforceKyc, false);
  const loaded = await service.loadProductionConfig();
  assert.equal(loaded.securityPolicy.requireFace, false);
  assert.equal(loaded.securityPolicy.requireIntegrity, true);
});

test('Ba app dùng bootstrap làm mới OTP, Driver/Merchant có màn loading riêng', () => {
  for (const app of ['User','Driver','Merchant']) {
    const service = read(`${app}/lib/services/app_feature_settings_service.dart`);
    assert.ok(service.includes('loadForRegistration'), `${app} missing bootstrap-aware settings`);
    assert.ok(service.includes('registrationBootstrap(role: role, phone: phone)'));
  }
  assert.ok(read('Driver/lib/pages/driver_splash_page.dart').includes('ImoveSplash.driver'));
  assert.ok(read('Merchant/lib/pages/merchant_splash_page.dart').includes('ImoveSplash.merchant'));
  assert.ok(read('Merchant/lib/main.dart').includes('const MerchantSplashPage('));
  assert.ok(read('Driver/lib/pages/driver_otp_page.dart').includes("role: 'DRIVER'"));
  assert.ok(read('Merchant/lib/pages/register_page.dart').includes('loadForRegistration'));
});
