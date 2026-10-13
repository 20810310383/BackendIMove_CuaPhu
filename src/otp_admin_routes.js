const express = require('express');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { createAdminGuard } = require('./admin_guard');
const { sendOtpSms, normalizePhone } = require('./otp_delivery_service');

function oid(value) {
  try {
    return value instanceof ObjectId ? value : new ObjectId(String(value));
  } catch (_) {
    return null;
  }
}

function clean(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function statusOf(row, now = new Date()) {
  if (row?.cancelledAt) return 'CANCELLED';
  if (row?.usedAt) return row?.supersededAt ? 'SUPERSEDED' : 'USED';
  if (row?.deliveryStatus === 'FAILED') return 'FAILED';
  if (row?.expiresAt && new Date(row.expiresAt).getTime() <= now.getTime()) return 'EXPIRED';
  if (row?.deliveryStatus === 'SENT') return 'SENT';
  if (row?.deliveryStatus === 'PENDING') return 'PENDING';
  return 'ACTIVE';
}

function maskPhone(value) {
  const p = normalizePhone(value);
  if (p.length < 7) return p;
  return `${p.slice(0, 3)}***${p.slice(-3)}`;
}

function serialize(row) {
  if (!row) return null;
  return {
    id: String(row._id),
    phone: row.phone || '',
    maskedPhone: maskPhone(row.phone),
    purpose: row.purpose || 'PHONE_VERIFY',
    status: statusOf(row),
    deliveryStatus: row.deliveryStatus || null,
    provider: row.provider || null,
    transactionId: row.transactionId || null,
    deliveryError: row.deliveryError || null,
    sentAt: row.sentAt || null,
    createdAt: row.createdAt || null,
    expiresAt: row.expiresAt || null,
    usedAt: row.usedAt || null,
    cancelledAt: row.cancelledAt || null,
    supersededAt: row.supersededAt || null,
    resendOf: row.resendOf ? String(row.resendOf) : null,
  };
}

function createOtpAdminRouter({ getDb }) {
  const router = express.Router();
  const { requireAdmin, permit } = createAdminGuard({ getDb });

  router.use(requireAdmin);

  router.get('/stats', permit('settings.view'), async (_req, res) => {
    try {
      const db = getDb();
      const now = new Date();
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const rows = await db.collection('otp_verifications')
        .find({ createdAt: { $gte: since } })
        .project({ usedAt: 1, cancelledAt: 1, expiresAt: 1, deliveryStatus: 1, supersededAt: 1 })
        .limit(5000)
        .toArray();

      const counts = {
        total24h: rows.length,
        active: 0,
        sent: 0,
        used: 0,
        failed: 0,
        expired: 0,
        cancelled: 0,
      };
      for (const row of rows) {
        const status = statusOf(row, now);
        if (status === 'SENT' || status === 'ACTIVE' || status === 'PENDING') counts.active += 1;
        if (status === 'SENT') counts.sent += 1;
        if (status === 'USED') counts.used += 1;
        if (status === 'FAILED') counts.failed += 1;
        if (status === 'EXPIRED') counts.expired += 1;
        if (status === 'CANCELLED') counts.cancelled += 1;
      }
      return res.json({ ok: true, ...counts, generatedAt: now.toISOString() });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.get('/', permit('settings.view'), async (req, res) => {
    try {
      const db = getDb();
      const query = {};
      const phone = normalizePhone(req.query.phone);
      const purpose = clean(req.query.purpose, 80).toUpperCase();
      const status = clean(req.query.status, 40).toUpperCase();
      const limit = Math.min(500, Math.max(20, Number(req.query.limit || 200)));

      if (phone) query.phone = { $regex: phone };
      if (purpose && purpose !== 'ALL') query.purpose = purpose;

      const rows = await db.collection('otp_verifications')
        .find(query)
        .sort({ createdAt: -1 })
        .limit(Math.max(limit * 3, 300))
        .toArray();

      let items = rows.map(serialize);
      if (status && status !== 'ALL') items = items.filter((row) => row.status === status);
      items = items.slice(0, limit);

      return res.json({ ok: true, rows: items, total: items.length });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.post('/:id/resend', permit('settings.manage'), async (req, res) => {
    try {
      const db = getDb();
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ message: 'ID OTP không hợp lệ.' });

      const old = await db.collection('otp_verifications').findOne({ _id: id });
      if (!old) return res.status(404).json({ message: 'Không tìm thấy OTP.' });

      const phone = normalizePhone(old.phone);
      const purpose = clean(old.purpose || 'PHONE_VERIFY', 80).toUpperCase();
      if (!phone) return res.status(400).json({ message: 'OTP không có số điện thoại hợp lệ.' });

      const resendSeconds = Math.max(30, Number(process.env.AUTH_OTP_RESEND_SECONDS || 60));
      const latest = await db.collection('otp_verifications').findOne(
        { phone, purpose },
        { sort: { createdAt: -1 } },
      );
      if (latest?.createdAt) {
        const waitMs = new Date(latest.createdAt).getTime() + resendSeconds * 1000 - Date.now();
        if (waitMs > 0) {
          return res.status(429).json({
            message: `Vui lòng chờ ${Math.ceil(waitMs / 1000)} giây trước khi gửi lại OTP.`,
          });
        }
      }

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
        resendOf: old._id,
        createdByAdmin: req.admin?._id || null,
      };

      const inserted = await db.collection('otp_verifications').insertOne(doc);
      doc._id = inserted.insertedId;

      try {
        const delivery = await sendOtpSms({ phone, otp, purpose });
        const sentAt = new Date();
        const deliveryPatch = {
          deliveryStatus: delivery?.delivered ? 'SENT' : 'PENDING',
          provider: delivery?.provider || null,
          transactionId: delivery?.transactionId || null,
          totalSMS: delivery?.totalSMS ?? null,
          totalPrice: delivery?.totalPrice ?? null,
          sentAt,
        };
        await db.collection('otp_verifications').updateOne({ _id: doc._id }, { $set: deliveryPatch });
        Object.assign(doc, deliveryPatch);
      } catch (error) {
        const failedAt = new Date();
        await db.collection('otp_verifications').updateOne(
          { _id: doc._id },
          { $set: { deliveryStatus: 'FAILED', deliveryError: clean(error.message, 500), failedAt } },
        );
        await db.collection('audit_logs').insertOne({
          actorType: 'ADMIN',
          actorId: req.admin?._id || null,
          action: 'OTP_RESEND_FAILED',
          entityType: 'OTP',
          entityId: String(doc._id),
          after: { phone: maskPhone(phone), purpose, error: clean(error.message, 500) },
          createdAt: failedAt,
        });
        return res.status(502).json({ message: error.message, otp: serialize({ ...doc, deliveryStatus: 'FAILED', deliveryError: error.message }) });
      }

      await db.collection('otp_verifications').updateOne(
        { _id: old._id, usedAt: null },
        { $set: { usedAt: new Date(), supersededAt: new Date(), supersededBy: doc._id } },
      );
      await db.collection('audit_logs').insertOne({
        actorType: 'ADMIN',
        actorId: req.admin?._id || null,
        action: 'OTP_RESEND',
        entityType: 'OTP',
        entityId: String(doc._id),
        after: { phone: maskPhone(phone), purpose, resendOf: String(old._id) },
        createdAt: new Date(),
      });

      return res.json({ ok: true, otp: serialize(doc) });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  router.post('/:id/cancel', permit('settings.manage'), async (req, res) => {
    try {
      const db = getDb();
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ message: 'ID OTP không hợp lệ.' });
      const now = new Date();
      const result = await db.collection('otp_verifications').findOneAndUpdate(
        { _id: id },
        { $set: { cancelledAt: now, usedAt: now, cancelledByAdmin: req.admin?._id || null } },
        { returnDocument: 'after' },
      );
      const row = result?.value || result;
      if (!row) return res.status(404).json({ message: 'Không tìm thấy OTP.' });
      await db.collection('audit_logs').insertOne({
        actorType: 'ADMIN',
        actorId: req.admin?._id || null,
        action: 'OTP_CANCEL',
        entityType: 'OTP',
        entityId: String(id),
        createdAt: now,
      });
      return res.json({ ok: true, otp: serialize(row) });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  return router;
}

module.exports = { createOtpAdminRouter };
