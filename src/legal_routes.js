const express = require('express');
const { createAdminGuard } = require('./admin_guard');

function clean(value, max = 20000) {
  return String(value ?? '').trim().slice(0, max);
}

function defaults() {
  return {
    termsTitle: 'Điều khoản sử dụng TH79 iMove',
    termsContent: 'Nội dung điều khoản sử dụng đang được cập nhật.',
    privacyTitle: 'Chính sách bảo mật TH79 iMove',
    privacyContent: 'Nội dung chính sách bảo mật đang được cập nhật.',
    version: '1.0',
    effectiveDate: null,
    updatedAt: null,
  };
}

function serialize(doc) {
  const base = defaults();
  const x = doc || {};
  return {
    termsTitle: clean(x.termsTitle || base.termsTitle, 240),
    termsContent: clean(x.termsContent || base.termsContent, 30000),
    privacyTitle: clean(x.privacyTitle || base.privacyTitle, 240),
    privacyContent: clean(x.privacyContent || base.privacyContent, 30000),
    version: clean(x.version || base.version, 40),
    effectiveDate: x.effectiveDate || null,
    updatedAt: x.updatedAt || null,
  };
}

function createLegalPublicRouter({ getDb }) {
  const r = express.Router();
  r.get('/', async (_req, res) => {
    try {
      const doc = await getDb().collection('app_legal_settings').findOne({ _id: 'PUBLIC_LEGAL' });
      return res.json({ ok: true, legal: serialize(doc) });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });
  return r;
}

function createLegalAdminRouter({ getDb }) {
  const r = express.Router();
  const { requireAdmin, permit } = createAdminGuard({ getDb });
  r.use(requireAdmin);

  r.get('/', permit('settings.view'), async (_req, res) => {
    try {
      const doc = await getDb().collection('app_legal_settings').findOne({ _id: 'PUBLIC_LEGAL' });
      return res.json({ ok: true, legal: serialize(doc) });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  r.put('/', permit('settings.manage'), async (req, res) => {
    try {
      const now = new Date();
      const patch = {
        termsTitle: clean(req.body?.termsTitle || 'Điều khoản sử dụng TH79 iMove', 240),
        termsContent: clean(req.body?.termsContent, 30000),
        privacyTitle: clean(req.body?.privacyTitle || 'Chính sách bảo mật TH79 iMove', 240),
        privacyContent: clean(req.body?.privacyContent, 30000),
        version: clean(req.body?.version || '1.0', 40),
        effectiveDate: req.body?.effectiveDate ? new Date(req.body.effectiveDate) : null,
        updatedAt: now,
        updatedBy: req.admin?._id || null,
      };
      if (patch.termsContent.length < 20 || patch.privacyContent.length < 20) {
        return res.status(400).json({ message: 'Điều khoản và chính sách bảo mật phải có nội dung đầy đủ.' });
      }
      await getDb().collection('app_legal_settings').updateOne(
        { _id: 'PUBLIC_LEGAL' },
        { $set: patch, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
      await getDb().collection('audit_logs').insertOne({
        actorType: 'ADMIN',
        actorId: req.admin?._id || null,
        action: 'LEGAL_SETTINGS_UPDATE',
        entityType: 'APP_LEGAL_SETTINGS',
        entityId: 'PUBLIC_LEGAL',
        after: { version: patch.version, effectiveDate: patch.effectiveDate },
        createdAt: now,
      }).catch(() => {});
      const doc = await getDb().collection('app_legal_settings').findOne({ _id: 'PUBLIC_LEGAL' });
      return res.json({ ok: true, legal: serialize(doc) });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });
  return r;
}

module.exports = { createLegalPublicRouter, createLegalAdminRouter };
