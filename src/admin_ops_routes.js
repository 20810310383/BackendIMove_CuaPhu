const express = require('express');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { mergeDriversWithLocations } = require('./driver_location_service');

function jwtSecret() {
  const secret = String(process.env.JWT_ACCESS_SECRET || '').trim();
  if (secret.length < 32) throw new Error('JWT_ACCESS_SECRET chưa được cấu hình an toàn.');
  return secret;
}
function safeObjectId(value) { try { return new ObjectId(String(value)); } catch (_) { return null; } }
function number(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function cleanLimit(value, fallback = 50, max = 200) { return Math.max(1, Math.min(max, Math.round(number(value, fallback)))); }
function pageNumber(value) { return Math.max(1, Math.round(number(value, 1))); }
function pagination(page, limit, total) { return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }; }
function bookingLabel(status) {
  const map = {
    SEARCHING: 'Đang tìm tài xế', DRIVER_ASSIGNED: 'Đã có tài xế', DRIVER_ARRIVING: 'Tài xế đang đến',
    DRIVER_ARRIVED: 'Tài xế đã đến', IN_PROGRESS: 'Đang chạy', COMPLETED: 'Hoàn thành',
    CANCELLED: 'Đã hủy', CANCELLED_BY_USER: 'Khách hủy', CANCELLED_BY_DRIVER: 'Tài xế hủy', EXPIRED: 'Hết thời gian',
  };
  return map[String(status || '').toUpperCase()] || String(status || '');
}

function createAdminOpsRouter({ getDb }) {
  const router = express.Router();

  async function requireAdmin(req, res, next) {
    try {
      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'Thiếu Access Token quản trị.' });
      const payload = jwt.verify(header.slice(7).trim(), jwtSecret());
      const userId = safeObjectId(payload.sub || payload.userId);
      if (!userId) return res.status(401).json({ message: 'Access Token không hợp lệ.' });
      const db = getDb();
      if (!db) return res.status(503).json({ message: 'Database chưa sẵn sàng.' });
      const user = await db.collection('users').findOne({ _id: userId, roles: 'ADMIN' });
      if (!user) return res.status(403).json({ message: 'Không có quyền ADMIN.' });
      req.admin = user;
      next();
    } catch (_) {
      return res.status(401).json({ message: 'Phiên quản trị không hợp lệ hoặc đã hết hạn.' });
    }
  }

  router.use(requireAdmin);

  router.get('/overview', async (req, res) => {
    try {
      const db = getDb();
      const now = new Date();
      const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
      const [customers, drivers, onlineDrivers, activeTrips, completedToday, todayAgg, pendingWithdrawals] = await Promise.all([
        db.collection('users').countDocuments({ roles: 'CUSTOMER', status: { $nin: ['DELETED'] } }),
        db.collection('drivers').countDocuments({}),
        db.collection('drivers').countDocuments({ onlineStatus: { $in: ['ONLINE', 'BUSY'] } }),
        db.collection('bookings').countDocuments({ status: { $in: ['SEARCHING','DRIVER_ASSIGNED','DRIVER_ARRIVING','DRIVER_ARRIVED','IN_PROGRESS'] } }),
        db.collection('bookings').countDocuments({ status: 'COMPLETED', completedAt: { $gte: startToday } }),
        db.collection('bookings').aggregate([
          { $match: { status: 'COMPLETED', completedAt: { $gte: startToday } } },
          { $group: { _id: null, revenue: { $sum: '$pricing.customerTotal' }, commission: { $sum: '$pricing.platformCommission' } } },
        ]).toArray(),
        db.collection('withdrawal_requests').countDocuments({ status: { $in: ['PENDING','APPROVED','PROCESSING'] } }),
      ]);
      const money = todayAgg[0] || {};
      return res.json({
        generatedAt: now.toISOString(),
        customers, drivers, onlineDrivers, activeTrips, completedToday,
        todayRevenue: Math.round(number(money.revenue)),
        todayCommission: Math.round(number(money.commission)),
        pendingWithdrawals,
      });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/bookings', async (req, res) => {
    try {
      const db = getDb();
      const limit = cleanLimit(req.query.limit, 20, 200);
      const page = pageNumber(req.query.page);
      const paged = req.query.page !== undefined;
      const status = String(req.query.status || '').trim().toUpperCase();
      const serviceCode = String(req.query.serviceCode || '').trim().toUpperCase();
      const q = String(req.query.q || '').trim();
      const filter = {};
      if (status && status !== 'ALL') filter.status = status;
      if (serviceCode && serviceCode !== 'ALL') filter.serviceCode = serviceCode;
      if (q) filter.$or = [{ bookingCode: { $regex: q, $options: 'i' } }, { 'pickup.address': { $regex: q, $options: 'i' } }, { 'destination.address': { $regex: q, $options: 'i' } }];
      const [rows, total] = await Promise.all([
        db.collection('bookings').find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
        paged ? db.collection('bookings').countDocuments(filter) : Promise.resolve(0),
      ]);
      const items = rows.map((x) => ({
        id: String(x._id), code: x.bookingCode || String(x._id), status: x.status, statusLabel: bookingLabel(x.status),
        pickup: x.pickup?.address || x.pickup?.addressText || '', destination: x.destination?.address || x.destination?.addressText || '',
        customerId: x.customerId ? String(x.customerId) : null, driverId: x.driverId ? String(x.driverId) : null,
        customerTotal: Math.round(number(x.pricing?.customerTotal || x.pricing?.total)),
        driverNetAmount: Math.round(number(x.pricing?.driverNetAmount)), platformCommission: Math.round(number(x.pricing?.platformCommission)),
        paymentStatus: x.paymentStatus || null, paymentMethod: x.paymentMethod || null,
        createdAt: iso(x.createdAt), completedAt: iso(x.completedAt), updatedAt: iso(x.updatedAt),
      }));
      return res.json(paged ? { items, pagination: pagination(page, limit, total) } : items);
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/bookings/:id', async (req, res) => {
    try {
      const db = getDb(); const id = safeObjectId(req.params.id);
      if (!id) return res.status(400).json({ message: 'Booking id không hợp lệ.' });
      const booking = await db.collection('bookings').findOne({ _id: id });
      if (!booking) return res.status(404).json({ message: 'Không tìm thấy chuyến.' });
      const [events, walletTx, customer, driver, vehicle] = await Promise.all([
        db.collection('booking_events').find({ bookingId: id }).sort({ createdAt: 1 }).limit(200).toArray(),
        db.collection('wallet_transactions').find({ bookingId: id }).sort({ createdAt: 1 }).toArray(),
        booking.customerId ? db.collection('users').findOne({ _id: booking.customerId }) : null,
        booking.driverId ? db.collection('drivers').findOne({ _id: booking.driverId }) : null,
        booking.vehicleId ? db.collection('vehicles').findOne({ _id: booking.vehicleId }) : null,
      ]);
      let driverUser = null;
      if (driver?.userId) driverUser = await db.collection('users').findOne({ _id: driver.userId });
      return res.json({
        booking: { ...booking, _id: String(booking._id), customerId: booking.customerId ? String(booking.customerId) : null, driverId: booking.driverId ? String(booking.driverId) : null, vehicleId: booking.vehicleId ? String(booking.vehicleId) : null },
        customer: customer ? { id: String(customer._id), fullName: customer.fullName, phone: customer.phone, email: customer.email } : null,
        driver: driver ? { id: String(driver._id), fullName: driverUser?.fullName || booking.driverSnapshot?.fullName || null, phone: driverUser?.phone || booking.driverSnapshot?.phone || null, onlineStatus: driver.onlineStatus, rating: driver.rating } : null,
        vehicle: vehicle ? { id: String(vehicle._id), plateNumber: vehicle.plateNumber, brand: vehicle.brand, model: vehicle.model, color: vehicle.color } : null,
        events: events.map((e) => ({ id: String(e._id), type: e.type, actorType: e.actorType, actorId: e.actorId ? String(e.actorId) : null, payload: e.payload || null, createdAt: iso(e.createdAt) })),
        financials: walletTx.map((t) => ({ id: String(t._id), type: t.type, title: t.title, amount: number(t.amount), status: t.status, createdAt: iso(t.createdAt) })),
      });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/drivers/live', async (req, res) => {
    try {
      const db = getDb();
      const limit = cleanLimit(req.query.limit, 100, 300);
      const drivers = await db.collection('drivers').find({}).sort({ updatedAt: -1 }).limit(limit).toArray();
      const driverIds = drivers.map((driver) => driver._id);
      const driverIdVariants = driverIds.flatMap((id) => [id, String(id)]);
      const locations = driverIds.length
        ? await db.collection('driver_locations').find({ driverId: { $in: driverIdVariants } }).toArray()
        : [];
      const maxAgeSeconds = Math.max(30, number(process.env.MATCHING_LOCATION_TTL_SECONDS, 120));
      return res.json(mergeDriversWithLocations(drivers, locations, {
        now: new Date(),
        maxAgeSeconds,
      }));
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  router.get('/integrity', async (req, res) => {
    try {
      const db = getDb();
      const [duplicateEarning, duplicateRewards, busyWithoutTrip, negativeWallets] = await Promise.all([
        db.collection('wallet_transactions').aggregate([{ $match: { type: 'DRIVER_TRIP_EARNING', bookingId: { $ne: null } } }, { $group: { _id: '$bookingId', count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }, { $count: 'count' }]).toArray(),
        db.collection('loyalty_transactions').aggregate([{ $match: { type: 'TRIP_REWARD', bookingId: { $ne: null } } }, { $group: { _id: '$bookingId', count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }, { $count: 'count' }]).toArray(),
        db.collection('drivers').countDocuments({ onlineStatus: 'BUSY', activeBookingId: null }),
        db.collection('wallets').countDocuments({ $or: [{ balance: { $lt: 0 } }, { availableBalance: { $lt: 0 } }, { lockedBalance: { $lt: 0 } }] }),
      ]);
      const issues = { duplicateEarning: duplicateEarning[0]?.count || 0, duplicateRewards: duplicateRewards[0]?.count || 0, busyWithoutTrip, negativeWallets };
      return res.json({ ok: Object.values(issues).every((x) => x === 0), issues, checkedAt: new Date().toISOString() });
    } catch (error) { return res.status(500).json({ message: error.message }); }
  });

  return router;
}

module.exports = { createAdminOpsRouter };
