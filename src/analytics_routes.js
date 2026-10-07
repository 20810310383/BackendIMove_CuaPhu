const express = require('express');
const { createAdminGuard } = require('./admin_guard');

function paymentGroup(status) {
  const value = String(status || '').toUpperCase();
  if (['PAID', 'SUCCESS', 'SUCCEEDED', 'COMPLETED'].includes(value)) return 'success';
  if (['FAILED', 'CANCELLED'].includes(value)) return 'failed';
  return 'pending';
}

function paymentSummary(rows) {
  return rows.reduce((summary, row) => {
    const amount = Number(row?.amount || 0);
    summary.total += 1;
    summary.amount += amount;
    const group = paymentGroup(row?.status);
    summary[group].count += 1;
    summary[group].amount += amount;
    return summary;
  }, {
    total: 0,
    amount: 0,
    success: { count: 0, amount: 0 },
    failed: { count: 0, amount: 0 },
    pending: { count: 0, amount: 0 },
  });
}

function createAnalyticsAdminRouter({ getDb, getAnalytics }) {
  const r = express.Router();
  const { requireAdmin, permit } = createAdminGuard({ getDb });

  r.use(requireAdmin);

  r.get('/', permit('reports.view'), async (req, res) => {
    try {
      const forceRefresh = String(req.query.refresh || '') === '1';
      const payload = await getAnalytics().report(req.query.days, { forceRefresh });
      return res.json(payload);
    } catch (error) {
      console.error('[Analytics] report failed:', error);
      return res.status(500).json({
        code: 'ANALYTICS_FAILED',
        message: error?.message || 'Không thể tải báo cáo Analytics.',
      });
    }
  });

  r.get('/payments', permit('payments.view'), async (req, res) => {
    try {
      const page = Math.max(1, Math.round(Number(req.query.page) || 1));
      const limit = Math.max(1, Math.min(100, Math.round(Number(req.query.limit) || 20)));
      const report = await getAnalytics().report(req.query.days || 30);
      const rows = Array.isArray(report?.payments) ? report.payments : [];
      return res.json({
        items: rows.slice((page - 1) * limit, page * limit),
        pagination: { page, limit, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / limit)) },
        summary: paymentSummary(rows),
      });
    } catch (error) {
      console.error('[Analytics] payments failed:', error);
      return res.status(500).json({
        code: 'PAYMENTS_FAILED',
        message: error?.message || 'Không thể tải danh sách giao dịch.',
      });
    }
  });

  return r;
}

module.exports = { createAnalyticsAdminRouter };
