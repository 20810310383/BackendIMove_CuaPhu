'use strict';

const express = require('express');
const { createAdminGuard } = require('./admin_guard');

function createWebTestCorsAdminRouter({ getDb, controller }) {
  const router = express.Router();
  const { requireAdmin, permit } = createAdminGuard({ getDb });
  router.use(requireAdmin);

  router.get('/web-test-cors', permit('settings.view'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json({ ok: true, config: await controller.status(), canManage: req.adminPermissions?.includes('*') || req.adminPermissions?.includes('settings.manage') || false }); }
    catch (_) { return res.status(503).json({ code: 'DB_UNAVAILABLE', message: 'Không tải được cấu hình kiểm thử Web.' }); }
  });

  router.put('/web-test-cors', permit('settings.manage'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const config = await controller.update({
        enabled: req.body?.enabled,
        minutes: req.body?.minutes ?? 60,
        actorId: req.admin?._id,
      });
      return res.json({ ok: true, config });
    } catch (error) {
      return res.status(error.httpStatus || 500).json({ message: error.message });
    }
  });
  return router;
}

module.exports = { createWebTestCorsAdminRouter };
