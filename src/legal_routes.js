'use strict';
const express = require('express');
const { createAdminGuard } = require('./admin_guard');

// Legal documents are isolated by app. No user-supplied HTML is stored/rendered.
const APP_IDS = Object.freeze(['USER', 'DRIVER', 'MERCHANT']);
const TYPES = Object.freeze(['paragraph', 'h2', 'h3', 'bullet', 'number', 'quote']);
const COLLECTION = 'app_legal_settings';

function appId(value) {
  const candidate = String(value || '').trim().toUpperCase();
  return APP_IDS.includes(candidate) ? candidate : null;
}
function clean(value, max = 20000) {
  return String(value ?? '').trim().slice(0, max);
}
function safeUrl(input) {
  const raw = String(input || '').trim().slice(0, 1000);
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch (_) { return null; }
}
function normalizeRich(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const rawBlock of value.slice(0, 400)) {
    if (!rawBlock || typeof rawBlock !== 'object' || !TYPES.includes(rawBlock.type)) continue;
    const runs = [];
    for (const rawRun of (Array.isArray(rawBlock.runs) ? rawBlock.runs : []).slice(0, 250)) {
      if (!rawRun || typeof rawRun !== 'object') continue;
      const text = String(rawRun.text ?? '').slice(0, 30000);
      if (!text) continue;
      const run = { text };
      if (rawRun.bold === true) run.bold = true;
      if (rawRun.italic === true) run.italic = true;
      if (rawRun.underline === true) run.underline = true;
      if (/^#[0-9a-f]{6}$/i.test(String(rawRun.color || ''))) run.color = String(rawRun.color).toLowerCase();
      const href = safeUrl(rawRun.href);
      if (href) run.href = href;
      runs.push(run);
    }
    if (runs.length) {
      const align = ['left', 'center', 'right', 'justify'].includes(rawBlock.align) ? rawBlock.align : undefined;
      result.push({ type: rawBlock.type, runs, ...(align ? { align } : {}) });
    }
  }
  return result;
}
function plainFromRich(rich) {
  return rich.map((block) => block.runs.map((run) => run.text).join('')).join('\n');
}
function richFromPlain(value) {
  return String(value || '').split(/\r?\n/).filter((s) => s.trim()).slice(0, 400)
    .map((s) => ({ type: 'paragraph', runs: [{ text: s.slice(0, 30000) }] }));
}
function defaults(app = null) {
  const suffix = app === 'DRIVER' ? 'Tài xế' : app === 'MERCHANT' ? 'Đối tác cửa hàng' : 'Khách hàng';
  return {
    app: app || 'LEGACY',
    termsTitle: `Điều khoản sử dụng TH79 iMove${app ? ' - ' + suffix : ''}`,
    termsContent: '', termsRich: [],
    privacyTitle: `Chính sách bảo mật TH79 iMove${app ? ' - ' + suffix : ''}`,
    privacyContent: '', privacyRich: [],
    version: '1.0', enabled: true, effectiveDate: null, updatedAt: null,
  };
}
function serialize(doc, app = null) {
  const base = defaults(app);
  const x = doc || {};
  const termsContent = clean(x.termsContent ?? base.termsContent, 30000);
  const privacyContent = clean(x.privacyContent ?? base.privacyContent, 30000);
  const termsRich = normalizeRich(x.termsRich);
  const privacyRich = normalizeRich(x.privacyRich);
  return {
    app: app || 'LEGACY',
    termsTitle: clean(x.termsTitle || base.termsTitle, 240),
    termsContent,
    termsRich: termsRich.length ? termsRich : richFromPlain(termsContent),
    privacyTitle: clean(x.privacyTitle || base.privacyTitle, 240),
    privacyContent,
    privacyRich: privacyRich.length ? privacyRich : richFromPlain(privacyContent),
    version: clean(x.version || base.version, 40),
    enabled: x.enabled !== false,
    effectiveDate: x.effectiveDate || null,
    updatedAt: x.updatedAt || null,
  };
}
async function readLegal(db, app) {
  const col = db.collection(COLLECTION);
  if (!app) return serialize(await col.findOne({ _id: 'PUBLIC_LEGAL' }));
  const own = await col.findOne({ _id: `LEGAL_${app}` });
  if (own) return serialize(own, app);
  // First-time migration: copy-on-first-edit semantics, do not mutate legacy.
  const legacy = await col.findOne({ _id: 'PUBLIC_LEGAL' });
  return serialize(legacy, app);
}
function createLegalPublicRouter({ getDb }) {
  const router = express.Router();
  router.get('/', async (req, res) => {
    try {
      const requested = req.query.app;
      const app = requested === undefined ? null : appId(requested);
      if (requested !== undefined && !app) return res.status(400).json({ message: 'app phải là USER, DRIVER hoặc MERCHANT.' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, legal: await readLegal(getDb(), app) });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });
  return router;
}
function createLegalAdminRouter({ getDb }) {
  const router = express.Router();
  const { requireAdmin, permit } = createAdminGuard({ getDb });
  router.use(requireAdmin);
  router.get('/', permit('settings.view'), async (req, res) => {
    try {
      const app = appId(req.query.app);
      if (!app) return res.status(400).json({ message: 'Chọn app USER, DRIVER hoặc MERCHANT.' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, legal: await readLegal(getDb(), app) });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });
  router.put('/', permit('settings.manage'), async (req, res) => {
    try {
      const app = appId(req.query.app || req.body?.app);
      if (!app) return res.status(400).json({ message: 'Phải chỉ định ứng dụng USER, DRIVER hoặc MERCHANT.' });
      const termsRich = normalizeRich(req.body?.termsRich);
      const privacyRich = normalizeRich(req.body?.privacyRich);
      const termsContent = plainFromRich(termsRich);
      const privacyContent = plainFromRich(privacyRich);
      if ((termsContent.trim().length > 0 && termsContent.trim().length < 20) ||
          (privacyContent.trim().length > 0 && privacyContent.trim().length < 20) ||
          (!termsContent.trim() && !privacyContent.trim())) {
        return res.status(400).json({ message: 'Mỗi tài liệu đã nhập phải có ít nhất 20 ký tự; có thể soạn và lưu tài liệu còn lại sau.' });
      }
      if (termsContent.length > 30000 || privacyContent.length > 30000) {
        return res.status(400).json({ message: 'Nội dung tối đa 30.000 ký tự mỗi tài liệu.' });
      }
      const effectiveRaw = req.body?.effectiveDate;
      const effectiveDate = effectiveRaw ? new Date(effectiveRaw) : null;
      if (effectiveDate && Number.isNaN(effectiveDate.getTime())) {
        return res.status(400).json({ message: 'Ngày hiệu lực không hợp lệ.' });
      }
      const now = new Date();
      const patch = {
        app,
        termsTitle: clean(req.body?.termsTitle, 240),
        termsContent, termsRich,
        privacyTitle: clean(req.body?.privacyTitle, 240),
        privacyContent, privacyRich,
        version: clean(req.body?.version, 40),
        enabled: req.body?.enabled !== false,
        effectiveDate,
        updatedAt: now,
        updatedBy: req.admin?._id || null,
      };
      if (!patch.termsTitle || !patch.privacyTitle || !patch.version) {
        return res.status(400).json({ message: 'Thiếu tiêu đề hoặc phiên bản.' });
      }
      const key = `LEGAL_${app}`;
      await getDb().collection(COLLECTION).updateOne(
        { _id: key },
        { $set: patch, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
      await getDb().collection('audit_logs').insertOne({
        actorType: 'ADMIN', actorId: req.admin?._id || null,
        action: 'LEGAL_SETTINGS_UPDATE', entityType: 'APP_LEGAL_SETTINGS', entityId: key,
        after: { app, version: patch.version, effectiveDate }, createdAt: now,
      }).catch(() => {});
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, legal: await readLegal(getDb(), app) });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });
  return router;
}
module.exports = { APP_IDS, appId, normalizeRich, plainFromRich, richFromPlain, serialize, createLegalPublicRouter, createLegalAdminRouter };
