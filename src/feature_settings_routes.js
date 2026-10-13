const express = require('express');
const { createAdminGuard } = require('./admin_guard');
const {
  getAppFeatureSettings,
  setAppFeatureSettings,
} = require('./app_feature_settings');

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').trim();
}

function validPhone(phone) {
  return /^0\d{9}$/.test(phone);
}

function createFeatureSettingsPublicRouter({ getDb }) {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      const settings = await getAppFeatureSettings(getDb());
      return res.json({ ok: true, settings });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  // API tương thích cho các app cũ: chỉ trả trạng thái OTP, KHÔNG cấp mã bypass.
  router.post('/registration-bootstrap', async (req, res) => {
    try {
      const db = getDb();
      const settings = await getAppFeatureSettings(db);
      const role = String(req.body?.role || '').trim().toUpperCase();
      const phone = normalizePhone(req.body?.phone);

      if (!validPhone(phone)) {
        return res.status(400).json({ message: 'Số điện thoại không hợp lệ.' });
      }

      if (!['CUSTOMER', 'DRIVER', 'MERCHANT'].includes(role)) {
        return res.status(400).json({ message: 'Role đăng ký không hợp lệ.' });
      }

      if (settings.otpVerificationEnabled) {
        return res.json({
          ok: true,
          otpRequired: true,
          legalInformationEnabled: settings.legalInformationEnabled,
        });
      }

      // OTP được tắt: Backend nhận đăng ký không kèm OTP.
      // Không tạo/phát hành mã xác minh giả hay token xác minh công khai.
      return res.json({
        ok: true,
        otpRequired: false,
        legalInformationEnabled: settings.legalInformationEnabled,
      });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  return router;
}

function createFeatureSettingsAdminRouter({ getDb }) {
  const router = express.Router();
  const { requireAdmin, permit } = createAdminGuard({ getDb });

  router.use(requireAdmin);

  router.get('/', permit('settings.view'), async (_req, res) => {
    try {
      const settings = await getAppFeatureSettings(getDb());
      return res.json({ ok: true, settings });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.put('/', permit('settings.manage'), async (req, res) => {
    try {
      const db = getDb();
      const before = await getAppFeatureSettings(db);
      const settings = await setAppFeatureSettings(
        db,
        {
          otpVerificationEnabled: req.body?.otpVerificationEnabled,
          legalInformationEnabled: req.body?.legalInformationEnabled,
        },
        req.admin?._id || null,
      );

      await db.collection('audit_logs').insertOne({
        actorType: 'ADMIN',
        actorId: req.admin?._id || null,
        action: 'APP_FEATURE_SETTINGS_UPDATE',
        entityType: 'APP_FEATURE_SETTINGS',
        entityId: 'GLOBAL_APP_FEATURES',
        before,
        after: settings,
        createdAt: new Date(),
      }).catch(() => {});

      return res.json({ ok: true, settings });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  return router;
}

module.exports = {
  createFeatureSettingsPublicRouter,
  createFeatureSettingsAdminRouter,
};
