'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = rel => fs.readFileSync(path.join(root,rel),'utf8');

test('OTP nằm ngay đầu Security Test Mode và có xác minh public API trước khi báo thành công', () => {
  const security = read('AdminIMove_CuaPhu/src/ProductionHealthPage.jsx');
  assert.ok(security.indexOf('id="registration-otp-settings"') > 0);
  assert.ok(security.indexOf('id="registration-otp-settings"') < security.indexOf('className="security-summary-grid"'));
  assert.equal((security.match(/<RegistrationOtpPanel access={access} \/>/g) || []).length,1);
  const panel = read('AdminIMove_CuaPhu/src/RegistrationOtpPanel.jsx');
  assert.match(panel,/coreApiRequest\('\/api\/v180\/admin\/app-settings'/);
  assert.match(panel,/getPublicRegistrationSettings\(\)/);
  assert.match(panel,/publicValue !== enabled/);
  assert.match(panel,/!enabled && !window.confirm/);
});

test('Backend phát hành config no-store và báo lỗi rõ nếu không có MongoDB', () => {
  const routes = read('BackendIMove_CuaPhu/src/feature_settings_routes.js');
  assert.match(routes,/Cache-Control', 'no-store, max-age=0'/);
  assert.match(routes,/DATABASE_UNAVAILABLE/);
  assert.match(routes,/INVALID_OTP_FLAG/);
});

test('3 app yêu cầu giá trị otpRequired từ bootstrap, không fallback sang cache khi API lỗi', () => {
  for (const app of ['User','Driver','Merchant']) {
    const src = read(`${app}/lib/services/app_feature_settings_service.dart`);
    const start = src.indexOf('Future<AppFeatureSettings> loadForRegistration(');
    const end = src.indexOf('Future<Map<String, dynamic>> registrationBootstrap(',start);
    const method = src.substring(start,end);
    assert.ok(method.includes("bootstrap['otpRequired'] is! bool"),app);
    assert.ok(!method.includes('return latest;\n    } catch'),app);
    assert.ok(method.includes("otpVerificationEnabled: bootstrap['otpRequired'] as bool"),app);
    const reg = read(`${app}/lib/pages/${app==='Driver'?'driver_register_page.dart':'register_page.dart'}`);
    assert.ok(reg.includes('loadForRegistration('),app);
    assert.ok(reg.includes('strict: true'),app);
  }
});

test('Trường OTP được bắt ở các điểm tạo tài khoản cuối cùng', () => {
  const auth = read('BackendIMove_CuaPhu/src/auth_routes.js');
  const merchant = read('BackendIMove_CuaPhu/src/merchant_registration_routes.js');
  assert.equal((auth.match(/const requireOtp = \(await getAppFeatureSettings\(db\)\)\.otpVerificationEnabled/g) || []).length >= 2,true);
  assert.ok(merchant.includes('const requireOtp = (await getAppFeatureSettings(db)).otpVerificationEnabled'));
  assert.ok(read('User/lib/pages/register_page.dart').includes("verificationToken = '';"));
  assert.ok(read('Driver/lib/pages/driver_register_page.dart').includes("otpCode: '',"));
  assert.ok(read('Merchant/lib/pages/register_page.dart').includes("await _registerWithOtp('');"));
});
