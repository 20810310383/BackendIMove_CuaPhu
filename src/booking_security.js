const path = require('path');
require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
  override: true,
});

const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

const JWT_ACCESS_SECRET = String(process.env.JWT_ACCESS_SECRET || '');

function safeObjectId(value) {
  try {
    return new ObjectId(String(value));
  } catch (_) {
    return null;
  }
}

function hasRole(user, role) {
  return Array.isArray(user?.roles) && user.roles.includes(role);
}

function createBookingSecurity({ getDb }) {
  async function authenticate(req, res) {
    try {
      if (!JWT_ACCESS_SECRET || JWT_ACCESS_SECRET.length < 32) {
        res.status(500).json({
          message: 'JWT_ACCESS_SECRET chưa được cấu hình an toàn.',
        });
        return null;
      }

      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) {
        res.status(401).json({ message: 'Thiếu Access Token.' });
        return null;
      }

      const token = header.substring(7).trim();
      if (!token) {
        res.status(401).json({ message: 'Access Token không hợp lệ.' });
        return null;
      }

      const payload = jwt.verify(token, JWT_ACCESS_SECRET, {
        issuer: 'th79-imove',
        audience: 'th79-imove-apps',
      });

      const userId = safeObjectId(payload.sub);
      if (!userId) {
        res.status(401).json({ message: 'Access Token không hợp lệ.' });
        return null;
      }

      const db = getDb();
      if (!db) {
        res.status(503).json({ message: 'MongoDB Atlas chưa sẵn sàng.' });
        return null;
      }

      const user = await db.collection('users').findOne({
        _id: userId,
        status: 'ACTIVE',
      });

      if (!user) {
        res.status(401).json({
          message: 'Tài khoản không tồn tại hoặc đã bị khóa.',
        });
        return null;
      }

      req.auth = { user, payload };
      return user;
    } catch (error) {
      if (error?.name === 'TokenExpiredError') {
        res.status(401).json({
          code: 'TOKEN_EXPIRED',
          message: 'Phiên đăng nhập đã hết hạn.',
        });
        return null;
      }

      res.status(401).json({
        code: 'INVALID_TOKEN',
        message: 'Access Token không hợp lệ.',
      });
      return null;
    }
  }

  async function loadDriverContext(user) {
    const db = getDb();
    const driver = await db.collection('drivers').findOne({ userId: user._id });
    if (!driver) return null;

    const vehicle = await db.collection('vehicles').findOne({
      driverId: driver._id,
      status: 'APPROVED',
    });

    return { user, driver, vehicle };
  }

  async function requireCustomer(req, res, next) {
    const user = await authenticate(req, res);
    if (!user) return;

    if (!hasRole(user, 'CUSTOMER')) {
      return res.status(403).json({
        message: 'API này chỉ dành cho khách hàng.',
      });
    }

    req.auth.role = 'CUSTOMER';
    return next();
  }

  async function requireApprovedDriver(req, res, next) {
    const user = await authenticate(req, res);
    if (!user) return;

    if (!hasRole(user, 'DRIVER')) {
      return res.status(403).json({
        message: 'API này chỉ dành cho tài xế.',
      });
    }

    const context = await loadDriverContext(user);
    if (!context) {
      return res.status(404).json({ message: 'Không tìm thấy hồ sơ tài xế.' });
    }

    if (context.driver.approvalStatus !== 'APPROVED') {
      return res.status(403).json({
        code: 'DRIVER_NOT_APPROVED',
        message: 'Tài xế chưa được duyệt.',
      });
    }

    if (context.driver.kycStatus !== 'APPROVED') {
      return res.status(403).json({
        code: 'DRIVER_KYC_NOT_APPROVED',
        message: 'Hồ sơ KYC của tài xế chưa được duyệt.',
      });
    }

    req.auth.role = 'DRIVER';
    req.driverContext = context;
    return next();
  }

  async function requireBookingParticipant(req, res, next) {
    const user = await authenticate(req, res);
    if (!user) return;

    const db = getDb();
    const bookingId = safeObjectId(req.params.id);
    if (!bookingId) {
      return res.status(400).json({ message: 'Booking id không hợp lệ.' });
    }

    const booking = await db.collection('bookings').findOne({ _id: bookingId });
    if (!booking) {
      return res.status(404).json({ message: 'Không tìm thấy chuyến.' });
    }

    if (hasRole(user, 'CUSTOMER') && String(booking.customerId) === String(user._id)) {
      req.auth.role = 'CUSTOMER';
      req.secureBooking = booking;
      return next();
    }

    if (hasRole(user, 'DRIVER')) {
      const context = await loadDriverContext(user);
      if (
        context &&
        booking.driverId &&
        String(booking.driverId) === String(context.driver._id)
      ) {
        req.auth.role = 'DRIVER';
        req.driverContext = context;
        req.secureBooking = booking;
        return next();
      }
    }

    return res.status(403).json({
      message: 'Bạn không có quyền xem chuyến này.',
    });
  }

  async function requireAssignedDriver(req, res, next) {
    const user = await authenticate(req, res);
    if (!user) return;

    if (!hasRole(user, 'DRIVER')) {
      return res.status(403).json({ message: 'API này chỉ dành cho tài xế.' });
    }

    const context = await loadDriverContext(user);
    if (!context) {
      return res.status(404).json({ message: 'Không tìm thấy hồ sơ tài xế.' });
    }

    if (context.driver.approvalStatus !== 'APPROVED') {
      return res.status(403).json({
        code: 'DRIVER_NOT_APPROVED',
        message: 'Tài xế chưa được duyệt.',
      });
    }

    const bookingId = safeObjectId(req.params.id);
    if (!bookingId) {
      return res.status(400).json({ message: 'Booking id không hợp lệ.' });
    }

    const db = getDb();
    const booking = await db.collection('bookings').findOne({ _id: bookingId });
    if (!booking) {
      return res.status(404).json({ message: 'Không tìm thấy chuyến.' });
    }

    if (!booking.driverId || String(booking.driverId) !== String(context.driver._id)) {
      return res.status(403).json({
        message: 'Tài xế không có quyền thao tác trên chuyến này.',
      });
    }

    req.auth.role = 'DRIVER';
    req.driverContext = context;
    req.secureBooking = booking;
    return next();
  }

  async function requireCancelParticipant(req, res, next) {
    const user = await authenticate(req, res);
    if (!user) return;

    const bookingId = safeObjectId(req.params.id);
    if (!bookingId) {
      return res.status(400).json({ message: 'Booking id không hợp lệ.' });
    }

    const db = getDb();
    const booking = await db.collection('bookings').findOne({ _id: bookingId });
    if (!booking) {
      return res.status(404).json({ message: 'Không tìm thấy chuyến.' });
    }

    if (hasRole(user, 'CUSTOMER') && String(booking.customerId) === String(user._id)) {
      req.auth.role = 'CUSTOMER';
      req.secureBooking = booking;
      return next();
    }

    if (hasRole(user, 'DRIVER')) {
      const context = await loadDriverContext(user);
      if (
        context &&
        booking.driverId &&
        String(booking.driverId) === String(context.driver._id)
      ) {
        req.auth.role = 'DRIVER';
        req.driverContext = context;
        req.secureBooking = booking;
        return next();
      }
    }

    return res.status(403).json({
      message: 'Bạn không có quyền hủy chuyến này.',
    });
  }

  return {
    requireCustomer,
    requireApprovedDriver,
    requireBookingParticipant,
    requireAssignedDriver,
    requireCancelParticipant,
  };
}

module.exports = { createBookingSecurity };