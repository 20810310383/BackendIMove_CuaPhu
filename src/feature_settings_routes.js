const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
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

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function jwtSecret() {
  const secret = String(process.env.JWT_ACCESS_SECRET || '').trim();
  if (secret.length < 32) {
    throw new Error('JWT_ACCESS_SECRET chưa được cấu hình an toàn.');
  }
  return secret;
}

async function createBypassOtp(db, { phone, purpose }) {
  const otp = generateOtp();
  const now = new Date();
  const minutes = Math.max(5, Number(process.env.AUTH_OTP_MINUTES || 5));
  const expiresAt = new Date(now.getTime() + minutes * 60 * 1000);

  await db.collection('otp_verifications').insertOne({
    phone,
    purpose,
    codeHash: sha256(otp),
    createdAt: now,
    expiresAt,
    usedAt: null,
    deliveryStatus: 'BYPASSED',
    provider: 'ADMIN_FEATURE_TOGGLE',
    bypassedBecauseOtpDisabled: true,
  });

  return { otp, expiresAt };
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

  // Endpoint này chỉ cấp bypass khi Admin đã chủ động TẮT OTP.
  // Khi OTP đang bật, app phải dùng luồng OTP hiện tại.
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

      if (role === 'CUSTOMER') {
        const verificationToken = jwt.sign(
          {
            phone,
            purpose: 'CUSTOMER_PHONE_VERIFY',
            kind: 'OTP_VERIFICATION',
            bypassedBecauseOtpDisabled: true,
          },
          jwtSecret(),
          {
            issuer: 'th79-imove',
            audience: 'th79-imove-apps',
            expiresIn: 10 * 60,
          },
        );

        return res.json({
          ok: true,
          otpRequired: false,
          verificationToken,
          expiresIn: 600,
          legalInformationEnabled: settings.legalInformationEnabled,
        });
      }

      const purpose = role === 'DRIVER' ? 'DRIVER_REGISTER' : 'MERCHANT_REGISTER';
      const bypass = await createBypassOtp(db, { phone, purpose });

      return res.json({
        ok: true,
        otpRequired: false,
        bypassOtp: bypass.otp,
        expiresAt: bypass.expiresAt.toISOString(),
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
