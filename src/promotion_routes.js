const express = require('express');
const { createAdminGuard } = require('./admin_guard');

function createPromotionCustomerRouter({ getPromotion, requireCustomer }) {
  const router = express.Router();
  router.use(requireCustomer);
  router.get('/eligible', async (req, res) => {
    try {
      const promotions = await getPromotion().eligible({ userId: req.auth.user._id, serviceCode: req.query.serviceCode || 'BIKE', orderAmount: Number(req.query.orderAmount || 0) });
      res.json({ promotions });
    } catch (error) { res.status(400).json({ message: error.message }); }
  });
  router.post('/validate', async (req, res) => {
    try {
      const value = await getPromotion().validatePromotion({ userId: req.auth.user._id, code: req.body?.code, serviceCode: req.body?.serviceCode, orderAmount: req.body?.orderAmount });
      res.json({ valid: true, discount: value.discount, finalAmount: value.finalAmount, promotionSnapshot: value.snapshot });
    } catch (error) { res.status(400).json({ valid: false, message: error.message }); }
  });
  return router;
}

function createPromotionAdminRouter({ getDb, getPromotion }) {
  const router = express.Router();
  const { requireAdmin, permit } = createAdminGuard({ getDb });
  router.use(requireAdmin);

  router.get('/customers/search', permit('promotions.view'), async (req, res) => {
    const q = String(req.query.q || '').trim();
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = q ? { $or: [{ fullName: { $regex: escaped, $options: 'i' } }, { phone: { $regex: escaped, $options: 'i' } }, { email: { $regex: escaped, $options: 'i' } }] } : {};
    const rows = await getDb().collection('users').find(filter).project({ fullName: 1, phone: 1, email: 1, roles: 1 }).limit(30).toArray();
    res.json({ users: rows.filter((row) => !Array.isArray(row.roles) || row.roles.includes('CUSTOMER')).map((row) => ({ _id: String(row._id), fullName: row.fullName || '', phone: row.phone || '', email: row.email || '' })) });
  });

  router.get('/', permit('promotions.view'), async (req, res) => {
    try {
      const page = Math.max(1, Math.round(Number(req.query.page) || 1));
      const limit = Math.max(1, Math.min(100, Math.round(Number(req.query.limit) || 20)));
      const [rows, total] = await Promise.all([
        getDb().collection('promotions').find({}).sort({ updatedAt: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
        getDb().collection('promotions').countDocuments({}),
      ]);
      res.json({ promotions: rows.map((row) => ({ ...row, _id: String(row._id) })), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
    } catch (error) { res.status(500).json({ message: error.message }); }
  });

  router.post('/', permit('promotions.manage'), async (req, res) => {
    try {
      const value = await getPromotion().save(req.body || {}, req.admin._id);
      await getDb().collection('audit_logs').insertOne({ actorType: 'ADMIN', actorId: req.admin._id, action: 'PROMOTION_UPSERT', entityType: 'PROMOTION', entityId: String(value._id), after: value, createdAt: new Date() });
      res.json({ ...value, _id: String(value._id) });
    } catch (error) { res.status(400).json({ message: error.message }); }
  });
  router.put('/:code', permit('promotions.manage'), async (req, res) => {
    try { const value = await getPromotion().save({ ...req.body, code: req.params.code }, req.admin._id); res.json({ ...value, _id: String(value._id) }); }
    catch (error) { res.status(400).json({ message: error.message }); }
  });
  router.get('/:code/stats', permit('promotions.view'), async (req, res) => {
    const promotion = await getDb().collection('promotions').findOne({ code: String(req.params.code).toUpperCase() });
    if (!promotion) return res.status(404).json({ message: 'Không tìm thấy mã.' });
    const [count, aggregate] = await Promise.all([
      getDb().collection('promotion_redemptions').countDocuments({ promotionId: promotion._id, status: 'REDEEMED' }),
      getDb().collection('promotion_redemptions').aggregate([{ $match: { promotionId: promotion._id, status: 'REDEEMED' } }, { $group: { _id: null, discount: { $sum: '$discountAmount' } } }]).toArray(),
    ]);
    res.json({ redemptions: count, totalDiscount: Number(aggregate[0]?.discount || 0) });
  });
  return router;
}

module.exports = { createPromotionCustomerRouter, createPromotionAdminRouter };
