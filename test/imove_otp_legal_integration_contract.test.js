'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  getAppFeatureSettings,
  setAppFeatureSettings,
} = require('../src/app_feature_settings');

const read = (p) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');
function fakeDb() {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new Map());
      const rows = collections.get(name);
      return {
        async findOne(query) { return rows.get(query._id) || null; },
        async updateOne(query, update) {
          const before = rows.get(query._id) || { _id: query._id };
          rows.set(query._id, { ...before, ...update.$set });
          return { acknowledged: true };
        },
      };
    },
  };
}

test('Bật/tắt OTP được lưu trong MongoDB và đồng bộ giữa các lần đọc', async () => {
  const db = fakeDb();
  const old = process.env.CUSTOMER_REGISTER_REQUIRE_OTP;
  process.env.CUSTOMER_REGISTER_REQUIRE_OTP = 'true';
  try {
    assert.equal((await getAppFeatureSettings(db)).otpVerificationEnabled, true);
    await setAppFeatureSettings(db, { otpVerificationEnabled: false }, 'test-admin');
    assert.equal((await getAppFeatureSettings(db)).otpVerificationEnabled, false);
    await setAppFeatureSettings(db, { otpVerificationEnabled: true }, 'test-admin');
    assert.equal((await getAppFeatureSettings(db)).otpVerificationEnabled, true);
  } finally {
    if (old === undefined) delete process.env.CUSTOMER_REGISTER_REQUIRE_OTP;
    else process.env.CUSTOMER_REGISTER_REQUIRE_OTP = old;
  }
});

test('Mọi API dành cho OTP, tài liệu pháp lý và đăng ký Merchant đều đã được mount', () => {
  const server = read('../src/server.js');
  for (const endpoint of [
    '/api/v180/app-settings', '/api/v180/admin/app-settings',
    '/api/v171/legal', '/api/v171/admin/legal',
    '/api/v171/admin/otp', '/api/v171/merchant-registration',
  ]) assert.ok(server.includes(`app.use('${endpoint}'`), `Missing ${endpoint}`);
});

test('Backend bắt OTP theo cấu hình động, không chấp nhận bypass khi OTP bật', () => {
  const auth = read('../src/auth_routes.js');
  const merchant = read('../src/merchant_registration_routes.js');
  const publicApi = read('../src/feature_settings_routes.js');
  assert.ok(auth.includes('const requireOtp = (await getAppFeatureSettings(db)).otpVerificationEnabled;'));
  assert.ok(merchant.includes('const requireOtp = (await getAppFeatureSettings(db)).otpVerificationEnabled;'));
  assert.ok(auth.includes('bypassedBecauseOtpDisabled === true'));
  assert.ok(merchant.includes('bypassedBecauseOtpDisabled: { $ne: true }'));
  assert.ok(!publicApi.includes('bypassOtp:'));
  assert.ok(!publicApi.includes('verificationToken,'));
});

test('Admin và ba ứng dụng cùng sử dụng đúng API và không cần mã khi OTP tắt', () => {
  const root = path.resolve(__dirname, '../..');
  const file = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const admin = file('AdminIMove_CuaPhu/src/App.jsx');
  const settings = file('AdminIMove_CuaPhu/src/LegalSettingsPage.jsx');
  assert.ok(admin.includes("page==='legal-settings'"));
  assert.ok(admin.includes("page==='otp-management'"));
  const otpPanel = file('AdminIMove_CuaPhu/src/RegistrationOtpPanel.jsx');
  const security = file('AdminIMove_CuaPhu/src/ProductionHealthPage.jsx');
  assert.ok(admin.includes("'legal-settings','Điều khoản & Bảo mật'"));
  assert.ok(security.includes('<RegistrationOtpPanel access={access} />'));
  assert.ok(otpPanel.includes('otpVerificationEnabled: enabled'));
  assert.ok(otpPanel.includes('/api/v180/admin/app-settings'));
  assert.ok(!settings.includes('otpVerificationEnabled: visible'));
  assert.ok(settings.includes("update('enabled', e.target.checked)")); // per-app visibility in v23
  assert.ok(settings.includes('/api/v171/admin/legal'));
  assert.ok(file('User/lib/pages/register_page.dart').includes("verificationToken = '';"));
  assert.ok(file('Driver/lib/pages/driver_register_page.dart').includes("otpCode: '',"));
  assert.ok(file('Merchant/lib/pages/register_page.dart').includes("await _registerWithOtp('');"));
  for (const app of ['User','Driver','Merchant']) {
    assert.ok(file(`${app}/lib/services/legal_service.dart`).includes('/api/v171/legal'));
    assert.ok(file(`${app}/lib/services/app_feature_settings_service.dart`).includes('/api/v180/app-settings'));
  }
});


test('Cập nhật từng cờ độc lập không ghi đè OTP hay trạng thái hiển thị pháp lý', async () => {
  const db = fakeDb();
  await setAppFeatureSettings(db, { otpVerificationEnabled: false, legalInformationEnabled: true }, 'admin');
  await setAppFeatureSettings(db, { legalInformationEnabled: false }, 'admin');
  assert.deepEqual(
    (({ otpVerificationEnabled, legalInformationEnabled }) => ({ otpVerificationEnabled, legalInformationEnabled }))(await getAppFeatureSettings(db)),
    { otpVerificationEnabled: false, legalInformationEnabled: false },
  );
  await setAppFeatureSettings(db, { otpVerificationEnabled: true }, 'admin');
  const result = await getAppFeatureSettings(db);
  assert.equal(result.otpVerificationEnabled, true);
  assert.equal(result.legalInformationEnabled, false);
});
