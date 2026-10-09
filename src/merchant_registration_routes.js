const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { sendOtpSms, assertOtpThrottle, normalizePhone } = require('./otp_delivery_service');

function clean(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function validVnPhone(phone) {
  return /^0\d{9}$/.test(normalizePhone(phone));
}

function createMerchantRegistrationRouter({ getDb }) {
  const router = express.Router();
  const purpose = 'MERCHANT_REGISTER';

  router.post('/request-otp', async (req, res) => {
    try {
      const db = getDb();
      const phone = normalizePhone(req.body?.phone);
      if (!validVnPhone(phone)) {
        return res.status(400).json({ message: 'Số điện thoại phải gồm 10 số và bắt đầu bằng 0.' });
      }

      const exists = await db.collection('users').findOne({ phone });
      if (exists) {
        return res.status(409).json({ message: 'Số điện thoại này đã có tài khoản trên hệ thống.' });
      }

      await assertOtpThrottle(db, { phone, purpose });

      const otp = generateOtp();
      const now = new Date();
      const minutes = Math.max(1, Number(process.env.AUTH_OTP_MINUTES || 5));
      const expiresAt = new Date(now.getTime() + minutes * 60 * 1000);
      const doc = {
        phone,
        purpose,
        codeHash: sha256(otp),
        createdAt: now,
        expiresAt,
        usedAt: null,
        deliveryStatus: 'PENDING',
      };
      const inserted = await db.collection('otp_verifications').insertOne(doc);
      doc._id = inserted.insertedId;

      try {
        const delivery = await sendOtpSms({ phone, otp, purpose });
        await db.collection('otp_verifications').updateOne(
          { _id: doc._id },
          { $set: {
            deliveryStatus: delivery?.delivered ? 'SENT' : 'PENDING',
            provider: delivery?.provider || null,
            smsType: delivery?.smsType || null,
            transactionId: delivery?.transactionId || null,
            sentAt: new Date(),
          } },
        );
      } catch (error) {
        await db.collection('otp_verifications').updateOne(
          { _id: doc._id },
          { $set: { deliveryStatus: 'FAILED', deliveryError: clean(error.message, 500), failedAt: new Date() } },
        );
        return res.status(502).json({ message: error.message || 'Không gửi được OTP.' });
      }

      const payload = {
        ok: true,
        message: `Đã gửi OTP đến ${phone}.`,
        expiresAt,
      };
      if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production' &&
          String(process.env.AUTH_DEV_SHOW_OTP || 'false').toLowerCase() === 'true') {
        payload.devOtp = otp;
      }
      return res.json(payload);
    } catch (error) {
      return res.status(Number(error.httpStatus) || 500).json({ message: error.message });
    }
  });

  router.post('/register', async (req, res) => {
    try {
      const db = getDb();
      const ownerName = clean(req.body?.ownerName, 160);
      const phone = normalizePhone(req.body?.phone);
      const email = clean(req.body?.email, 200).toLowerCase() || null;
      const password = String(req.body?.password || '');
      const otpCode = clean(req.body?.otpCode, 12);
      const merchantName = clean(req.body?.merchantName, 180);
      const merchantType = clean(req.body?.merchantType || 'STORE', 30).toUpperCase();
      const address = clean(req.body?.address, 300);

      if (ownerName.length < 2) return res.status(400).json({ message: 'Vui lòng nhập tên chủ cửa hàng.' });
      if (!validVnPhone(phone)) return res.status(400).json({ message: 'Số điện thoại không hợp lệ.' });
      if (password.length < 6) return res.status(400).json({ message: 'Mật khẩu phải có ít nhất 6 ký tự.' });
      if (merchantName.length < 2) return res.status(400).json({ message: 'Vui lòng nhập tên cửa hàng/nhà hàng.' });
      if (!['STORE', 'RESTAURANT'].includes(merchantType)) return res.status(400).json({ message: 'Loại đối tác không hợp lệ.' });
      if (otpCode.length !== 6) return res.status(400).json({ message: 'OTP phải gồm 6 số.' });

      const exists = await db.collection('users').findOne({ phone });
      if (exists) return res.status(409).json({ message: 'Số điện thoại này đã có tài khoản.' });

      const otp = await db.collection('otp_verifications').findOne(
        { phone, purpose, usedAt: null, cancelledAt: { $exists: false } },
        { sort: { createdAt: -1 } },
      );
      if (!otp) return res.status(400).json({ message: 'Không tìm thấy OTP hợp lệ. Vui lòng gửi mã mới.' });
      if (new Date(otp.expiresAt).getTime() <= Date.now()) return res.status(400).json({ message: 'OTP đã hết hạn. Vui lòng gửi mã mới.' });
      if (sha256(otpCode) !== String(otp.codeHash || '')) return res.status(400).json({ message: 'Mã OTP không đúng.' });

      const now = new Date();
      const passwordHash = await bcrypt.hash(password, 12);
      const userDoc = {
        phone,
        fullName: ownerName,
        email,
        passwordHash,
        avatarUrl: null,
        status: 'ACTIVE',
        roles: ['MERCHANT'],
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      };
      const userInsert = await db.collection('users').insertOne(userDoc);
      userDoc._id = userInsert.insertedId;

      try {
        const merchantDoc = {
          name: merchantName,
          merchantType,
          merchantTypeLabel: merchantType === 'RESTAURANT' ? 'Nhà hàng · Food' : 'Cửa hàng · Đặt hộ',
          categoryCode: merchantType === 'RESTAURANT' ? 'FOOD' : 'ERRAND',
          categoryName: merchantType === 'RESTAURANT' ? 'Nhà hàng' : 'Cửa hàng',
          phone,
          address,
          description: '',
          status: 'PENDING',
          commissionRate: 0,
          logoUrl: null,
          coverUrl: null,
          createdAt: now,
          updatedAt: now,
          registrationSource: 'MERCHANT_APP',
        };
        const merchantInsert = await db.collection('merchants').insertOne(merchantDoc);
        merchantDoc._id = merchantInsert.insertedId;

        await db.collection('merchant_users').insertOne({
          merchantId: merchantDoc._id,
          userId: userDoc._id,
          role: 'OWNER',
          status: 'ACTIVE',
          createdAt: now,
          updatedAt: now,
        });

        await db.collection('otp_verifications').updateOne(
          { _id: otp._id, usedAt: null },
          { $set: { usedAt: now, verifiedAt: now } },
        );

        await db.collection('audit_logs').insertOne({
          actorType: 'MERCHANT_REGISTER',
          actorId: userDoc._id,
          action: 'MERCHANT_SELF_REGISTER',
          entityType: 'MERCHANT',
          entityId: String(merchantDoc._id),
          after: { phone, merchantName, merchantType, status: 'PENDING' },
          createdAt: now,
        }).catch(() => {});

        return res.status(201).json({
          ok: true,
          merchantId: String(merchantDoc._id),
          status: 'PENDING',
          message: 'Đăng ký đối tác thành công. Hồ sơ đang chờ Admin duyệt.',
        });
      } catch (error) {
        await db.collection('users').deleteOne({ _id: userDoc._id }).catch(() => {});
        throw error;
      }
    } catch (error) {
      return res.status(500).json({ message: error.message || 'Không thể đăng ký Merchant.' });
    }
  });

  return router;
}

module.exports = { createMerchantRegistrationRouter };
