const { ObjectId } = require('mongodb');
const { DEFAULT_SERVICES } = require('./service_catalog_service');
const { reconcileSystemRoles } = require('./system_roles');

const numeric = ['double', 'int', 'long', 'decimal'];
const nullableNumeric = [...numeric, 'null'];
const geoPointSchema = {
  bsonType: 'object',
  required: ['type', 'coordinates'],
  properties: {
    type: { enum: ['Point'] },
    coordinates: { bsonType: 'array', minItems: 2, maxItems: 2, items: { bsonType: numeric } },
  },
};

const schemas = {
  drivers: {
    bsonType: 'object',
    required: ['userId', 'approvalStatus', 'onlineStatus'],
    properties: {
      userId: { bsonType: 'objectId' },
      approvalStatus: { enum: ['DRAFT', 'OTP_PENDING', 'DOCUMENT_PENDING', 'PENDING_REVIEW', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] },
      onlineStatus: { enum: ['OFFLINE', 'ONLINE', 'BUSY'] },
      rating: { bsonType: nullableNumeric },
      completedTrips: { bsonType: nullableNumeric },
      cancelledTrips: { bsonType: nullableNumeric },
      acceptanceRate: { bsonType: nullableNumeric },
      activeBookingId: { bsonType: ['objectId', 'null'] },
      activeCommerceOrderId: { bsonType: ['objectId', 'null'] },
      currentOfferBookingId: { bsonType: ['objectId', 'null'] },
      currentOfferExpiresAt: { bsonType: ['date', 'null'] },
      approvedAt: { bsonType: ['date', 'null'] },
      createdAt: { bsonType: ['date', 'null'] },
      updatedAt: { bsonType: ['date', 'null'] },
    },
  },
  bookings: {
    bsonType: 'object',
    required: ['bookingCode', 'customerId', 'serviceCode', 'status', 'pickup', 'destination', 'pricing', 'createdAt'],
    properties: {
      bookingCode: { bsonType: 'string' },
      customerId: { bsonType: 'objectId' },
      driverId: { bsonType: ['objectId', 'null'] },
      vehicleId: { bsonType: ['objectId', 'null'] },
      serviceCode: { bsonType: 'string' },
      areaCode: { bsonType: ['string', 'null'] },
      status: { enum: ['DRAFT', 'SEARCHING', 'OFFERED', 'NO_DRIVER', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CANCELLED_BY_USER', 'CANCELLED_BY_DRIVER', 'EXPIRED'] },
      pickup: { bsonType: 'object', required: ['location'], properties: { address: { bsonType: ['string', 'null'] }, note: { bsonType: ['string', 'null'] }, location: geoPointSchema } },
      destination: { bsonType: 'object', required: ['location'], properties: { address: { bsonType: ['string', 'null'] }, note: { bsonType: ['string', 'null'] }, location: geoPointSchema } },
      estimatedDistanceKm: { bsonType: nullableNumeric },
      estimatedDurationMinutes: { bsonType: nullableNumeric },
      actualDistanceKm: { bsonType: nullableNumeric },
      actualDurationMinutes: { bsonType: nullableNumeric },
      paymentMethod: { enum: ['CASH', 'BANK_TRANSFER', 'MOMO', 'VNPAY', 'WALLET', null] },
      paymentStatus: { enum: ['UNPAID', 'PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', null] },
      fareConfigVersion: { bsonType: nullableNumeric },
      platformFeeVersion: { bsonType: nullableNumeric },
      pricing: { bsonType: 'object' },
      cancellation: { bsonType: ['object', 'null'] },
      requestedAt: { bsonType: ['date', 'null'] },
      assignedAt: { bsonType: ['date', 'null'] },
      driverDepartedAt: { bsonType: ['date', 'null'] },
      driverArrivedAt: { bsonType: ['date', 'null'] },
      startedAt: { bsonType: ['date', 'null'] },
      completedAt: { bsonType: ['date', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: ['date', 'null'] },
    },
  },
  booking_events: {
    bsonType: 'object',
    required: ['bookingId', 'type', 'createdAt'],
    properties: {
      bookingId: { bsonType: 'objectId' },
      type: { bsonType: 'string' },
      actorType: { enum: ['CUSTOMER', 'DRIVER', 'ADMIN', 'SYSTEM', null] },
      actorId: { bsonType: ['objectId', 'null'] },
      payload: { bsonType: ['object', 'null'] },
      createdAt: { bsonType: 'date' },
    },
  },
  wallets: {
    bsonType: 'object',
    required: ['userId', 'type', 'currency', 'balance', 'availableBalance'],
    properties: {
      userId: { bsonType: 'objectId' },
      type: { enum: ['CUSTOMER', 'DRIVER'] },
      currency: { enum: ['VND'] },
      balance: { bsonType: numeric },
      availableBalance: { bsonType: numeric },
      lockedBalance: { bsonType: numeric },
      createdAt: { bsonType: ['date', 'null'] },
      updatedAt: { bsonType: ['date', 'null'] },
    },
  },
  wallet_transactions: {
    bsonType: 'object',
    required: ['walletId', 'type', 'amount', 'status', 'createdAt'],
    properties: {
      walletId: { bsonType: 'objectId' },
      userId: { bsonType: ['objectId', 'null'] },
      driverId: { bsonType: ['objectId', 'null'] },
      bookingId: { bsonType: ['objectId', 'null'] },
      type: { enum: ['TRIP_EARNING', 'DRIVER_TRIP_EARNING', 'BOOKING_PAYMENT', 'DEMO_TOPUP', 'COMMISSION', 'ADJUSTMENT', 'TOPUP', 'WITHDRAWAL', 'REFUND', 'PENALTY', 'BONUS'] },
      title: { bsonType: ['string', 'null'] },
      amount: { bsonType: numeric },
      balanceAfter: { bsonType: nullableNumeric },
      status: { enum: ['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'] },
      reference: { bsonType: ['string', 'null'] },
      seedTag: { bsonType: ['string', 'null'] },
      createdAt: { bsonType: 'date' },
    },
  },
  loyalty_accounts: {
    bsonType: 'object',
    required: ['userId', 'balance', 'lifetimeEarned', 'lifetimeSpent'],
    properties: {
      userId: { bsonType: 'objectId' },
      balance: { bsonType: numeric },
      lifetimeEarned: { bsonType: numeric },
      lifetimeSpent: { bsonType: numeric },
      createdAt: { bsonType: ['date', 'null'] },
      updatedAt: { bsonType: ['date', 'null'] },
    },
  },
  loyalty_transactions: {
    bsonType: 'object',
    required: ['userId', 'type', 'points', 'status', 'createdAt'],
    properties: {
      userId: { bsonType: 'objectId' },
      bookingId: { bsonType: ['objectId', 'null'] },
      type: { enum: ['WELCOME_BONUS', 'TRIP_REWARD', 'PROMOTION', 'REDEEM', 'ADJUSTMENT', 'REFUND', 'POINT_REVERSAL'] },
      title: { bsonType: ['string', 'null'] },
      points: { bsonType: numeric },
      balanceAfter: { bsonType: numeric },
      reference: { bsonType: ['string', 'null'] },
      status: { enum: ['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'] },
      seedTag: { bsonType: ['string', 'null'] },
      createdAt: { bsonType: 'date' },
    },
  },
  driver_reward_accounts: {
    bsonType: 'object',
    required: ['driverId', 'balance'],
    properties: {
      driverId: { bsonType: 'objectId' },
      userId: { bsonType: ['objectId', 'null'] },
      balance: { bsonType: numeric },
      lifetimeEarned: { bsonType: numeric },
      lifetimeSpent: { bsonType: numeric },
      pointValueVnd: { bsonType: nullableNumeric },
      createdAt: { bsonType: ['date', 'null'] },
      updatedAt: { bsonType: ['date', 'null'] },
    },
  },
  driver_reward_transactions: {
    bsonType: 'object',
    required: ['driverId', 'type', 'points', 'createdAt'],
    properties: {
      driverId: { bsonType: 'objectId' },
      userId: { bsonType: ['objectId', 'null'] },
      bookingId: { bsonType: ['objectId', 'null'] },
      topupId: { bsonType: ['objectId', 'null'] },
      adminId: { bsonType: ['objectId', 'null'] },
      sourceTransactionId: { bsonType: ['string', 'null'] },
      type: { bsonType: 'string' },
      direction: { enum: ['CREDIT', 'DEBIT', null] },
      points: { bsonType: numeric },
      amountVnd: { bsonType: nullableNumeric },
      title: { bsonType: ['string', 'null'] },
      reason: { bsonType: ['string', 'null'] },
      reference: { bsonType: ['string', 'null'] },
      transferCode: { bsonType: ['string', 'null'] },
      transferContent: { bsonType: ['string', 'null'] },
      createdAt: { bsonType: 'date' },
    },
  },
  driver_point_topups: {
    bsonType: 'object',
    required: ['driverId', 'userId', 'points', 'status', 'createdAt'],
    properties: {
      driverId: { bsonType: 'objectId' },
      userId: { bsonType: 'objectId' },
      driverSnapshot: { bsonType: ['object', 'null'] },
      fundType: { bsonType: ['string', 'null'] },
      paymentMethod: { bsonType: ['string', 'null'] },
      amountVnd: { bsonType: numeric },
      points: { bsonType: numeric },
      pointValueVnd: { bsonType: nullableNumeric },
      transferCode: { bsonType: ['string', 'null'] },
      transferContent: { bsonType: ['string', 'null'] },
      transferContentNormalized: { bsonType: ['string', 'null'] },
      bankInfo: { bsonType: ['object', 'null'] },
      status: { enum: ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'AMOUNT_MISMATCH'] },
      note: { bsonType: ['string', 'null'] },
      rejectReason: { bsonType: ['string', 'null'] },
      confirmedVia: { bsonType: ['string', 'null'] },
      bankTransactionId: { bsonType: ['string', 'null'] },
      receivedAmountVnd: { bsonType: nullableNumeric },
      approvedBy: { bsonType: ['objectId', 'null'] },
      rejectedBy: { bsonType: ['objectId', 'null'] },
      approvedAt: { bsonType: ['date', 'null'] },
      rejectedAt: { bsonType: ['date', 'null'] },
      bankOccurredAt: { bsonType: ['date', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: ['date', 'null'] },
    },
  },
  promotions: {
    bsonType: 'object',
    required: ['code', 'name', 'discountType', 'discountValue', 'status'],
    properties: {
      code: { bsonType: 'string' },
      name: { bsonType: 'string' },
      discountType: { enum: ['FIXED', 'PERCENT'] },
      discountValue: { bsonType: numeric },
      value: { bsonType: nullableNumeric },
      maxDiscount: { bsonType: nullableNumeric },
      minOrderAmount: { bsonType: nullableNumeric },
      minOrderValue: { bsonType: nullableNumeric },
      serviceCodes: { bsonType: ['array', 'null'], items: { bsonType: 'string' } },
      totalUsageLimit: { bsonType: nullableNumeric },
      usageLimit: { bsonType: nullableNumeric },
      perUserLimit: { bsonType: nullableNumeric },
      newCustomerOnly: { bsonType: ['bool', 'null'] },
      startAt: { bsonType: ['date', 'null'] },
      startsAt: { bsonType: ['date', 'null'] },
      endAt: { bsonType: ['date', 'null'] },
      endsAt: { bsonType: ['date', 'null'] },
      createdBy: { bsonType: ['objectId', 'null'] },
      updatedBy: { bsonType: ['objectId', 'null'] },
      createdAt: { bsonType: ['date', 'null'] },
      updatedAt: { bsonType: ['date', 'null'] },
      status: { enum: ['DRAFT', 'ACTIVE', 'INACTIVE', 'EXPIRED'] },
    },
  },
  matching_policies: {
    bsonType: 'object',
    required: ['key', 'version', 'status', 'strategy', 'autoDispatchEnabled'],
    properties: {
      key: { bsonType: 'string' },
      version: { bsonType: numeric },
      status: { enum: ['ACTIVE', 'INACTIVE'] },
      strategy: { bsonType: 'string' },
      autoDispatchEnabled: { bsonType: 'bool' },
      offerTimeoutSeconds: { bsonType: numeric },
      searchRetrySeconds: { bsonType: numeric },
      maxRadiusKm: { bsonType: numeric },
      locationFreshSeconds: { bsonType: numeric },
      maxCandidates: { bsonType: numeric },
      allowNoGpsFallback: { bsonType: 'bool' },
      filters: { bsonType: 'object' },
      weights: { bsonType: 'object' },
      fairness: { bsonType: 'object' },
      pointsPolicy: { bsonType: 'object' },
      updatedBy: { bsonType: ['objectId', 'null'] },
      createdAt: { bsonType: ['date', 'null'] },
      updatedAt: { bsonType: ['date', 'null'] },
    },
  },
  notifications: {
    bsonType: 'object',
    properties: {
      userId: { bsonType: ['objectId', 'null'] },
      targetId: { bsonType: ['objectId', 'null'] },
      targetType: { enum: ['CUSTOMER', 'DRIVER', 'ADMIN', 'MERCHANT', null] },
      title: { bsonType: ['string', 'null'] },
      body: { bsonType: ['string', 'null'] },
      type: { bsonType: ['string', 'null'] },
      data: { bsonType: ['object', 'null'] },
      status: { bsonType: ['string', 'null'] },
      dedupeKey: { bsonType: ['string', 'null'] },
      bookingId: { bsonType: ['objectId', 'null'] },
      offerId: { bsonType: ['objectId', 'null'] },
      broadcastId: { bsonType: ['objectId', 'null'] },
      level: { bsonType: ['int', 'long', 'double', 'null'] },
      requireAck: { bsonType: ['bool', 'null'] },
      expiresAt: { bsonType: ['date', 'null'] },
      readAt: { bsonType: ['date', 'null'] },
      openedAt: { bsonType: ['date', 'null'] },
      deliveredAt: { bsonType: ['date', 'null'] },
      acknowledgedAt: { bsonType: ['date', 'null'] },
      sentAt: { bsonType: ['date', 'null'] },
      createdAt: { bsonType: ['date', 'null'] },
      updatedAt: { bsonType: ['date', 'null'] },
    },
  },

};

function toObjectId(value) {
  if (value == null || value === '') return value;
  if (value instanceof ObjectId) return value;
  try { return new ObjectId(String(value)); } catch (_) { return value; }
}

function toDate(value, fallback = null) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value == null || value === '') return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function validCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePoint(container, fallbackLat = null, fallbackLng = null) {
  const source = container && typeof container === 'object' ? container : {};
  const loc = source.location && typeof source.location === 'object' ? source.location : {};
  let lng = validCoord(loc?.coordinates?.[0]);
  let lat = validCoord(loc?.coordinates?.[1]);
  if (lng == null) lng = validCoord(source.longitude ?? source.lng ?? fallbackLng);
  if (lat == null) lat = validCoord(source.latitude ?? source.lat ?? fallbackLat);
  if (lng == null) lng = 0;
  if (lat == null) lat = 0;
  return {
    ...source,
    address: source.address == null ? '' : String(source.address),
    location: { type: 'Point', coordinates: [lng, lat] },
  };
}

async function normalizeBookings(db, logger = console) {
  const cursor = db.collection('bookings').find({});
  let count = 0;
  while (await cursor.hasNext()) {
    const row = await cursor.next();
    const patch = {};
    const statusMap = {
      PENDING: 'SEARCHING', ACCEPTED: 'DRIVER_ASSIGNED', ARRIVING: 'DRIVER_ARRIVING',
      ARRIVED: 'DRIVER_ARRIVED', STARTED: 'IN_PROGRESS', RUNNING: 'IN_PROGRESS',
      FINISHED: 'COMPLETED', DONE: 'COMPLETED', CANCELED: 'CANCELLED',
    };
    const rawStatus = String(row.status || 'SEARCHING').toUpperCase();
    const status = statusMap[rawStatus] || rawStatus;
    if (status !== row.status) patch.status = status;
    if (!row.bookingCode || typeof row.bookingCode !== 'string') patch.bookingCode = String(row.bookingCode || `LEGACY-${row._id}`);
    if (!row.serviceCode || typeof row.serviceCode !== 'string') patch.serviceCode = 'BIKE';
    if (!row.pricing || typeof row.pricing !== 'object' || Array.isArray(row.pricing)) patch.pricing = {};
    if (!(row.createdAt instanceof Date)) patch.createdAt = toDate(row.createdAt, new Date());
    if (row.updatedAt != null && !(row.updatedAt instanceof Date)) patch.updatedAt = toDate(row.updatedAt, new Date());
    for (const key of ['customerId', 'driverId', 'vehicleId']) {
      const normalized = toObjectId(row[key]);
      if (normalized !== row[key] && normalized instanceof ObjectId) patch[key] = normalized;
    }
    const pickup = normalizePoint(row.pickup, row.pickupLatitude, row.pickupLongitude);
    const destination = normalizePoint(row.destination, row.destinationLatitude, row.destinationLongitude);
    const pickupCoords = row.pickup?.location?.coordinates;
    const destinationCoords = row.destination?.location?.coordinates;
    const pickupNeedsRepair = row.pickup?.location?.type !== 'Point' || !Array.isArray(pickupCoords) || pickupCoords.length < 2 || !pickupCoords.every((x) => typeof x === 'number' && Number.isFinite(x));
    const destinationNeedsRepair = row.destination?.location?.type !== 'Point' || !Array.isArray(destinationCoords) || destinationCoords.length < 2 || !destinationCoords.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (pickupNeedsRepair) patch.pickup = pickup;
    if (destinationNeedsRepair) patch.destination = destination;
    const numericFields = ['estimatedDistanceKm', 'estimatedDurationMinutes', 'actualDistanceKm', 'actualDurationMinutes'];
    for (const key of numericFields) {
      if (row[key] != null && typeof row[key] !== 'number') patch[key] = numberOr(row[key], 0);
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = patch.updatedAt || new Date();
      await db.collection('bookings').updateOne({ _id: row._id }, { $set: patch }, { bypassDocumentValidation: true });
      count += 1;
    }
  }
  logger.log?.(`[DB REPAIR] bookings updated: ${count}`);
  return count;
}

async function normalizeDrivers(db, logger = console) {
  const cursor = db.collection('drivers').find({});
  let count = 0;
  while (await cursor.hasNext()) {
    const row = await cursor.next();
    const patch = {};
    const userId = toObjectId(row.userId);
    if (userId instanceof ObjectId && userId !== row.userId) patch.userId = userId;
    const numericFields = ['rating', 'completedTrips', 'cancelledTrips', 'acceptanceRate'];
    for (const key of numericFields) {
      if (row[key] != null && typeof row[key] !== 'number') patch[key] = numberOr(row[key], 0);
    }
    const online = String(row.onlineStatus || 'OFFLINE').toUpperCase();
    patch.onlineStatus = ['OFFLINE', 'ONLINE', 'BUSY'].includes(online) ? online : 'OFFLINE';
    const approvalRaw = String(row.approvalStatus || row.status || '').toUpperCase();
    const approvalMap = { ACTIVE: 'APPROVED', VERIFIED: 'APPROVED', REVIEW: 'PENDING_REVIEW', WAITING: 'PENDING', BLOCKED: 'SUSPENDED' };
    const allowed = ['DRAFT', 'OTP_PENDING', 'DOCUMENT_PENDING', 'PENDING_REVIEW', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'];
    patch.approvalStatus = allowed.includes(approvalRaw) ? approvalRaw : (approvalMap[approvalRaw] || 'PENDING');
    for (const key of ['activeBookingId', 'currentOfferBookingId']) {
      if (row[key] != null) {
        const value = toObjectId(row[key]);
        if (value instanceof ObjectId) patch[key] = value;
      }
    }
    if (row.currentOfferExpiresAt != null) patch.currentOfferExpiresAt = toDate(row.currentOfferExpiresAt, null);
    if (row.approvedAt != null) patch.approvedAt = toDate(row.approvedAt, null);
    patch.updatedAt = new Date();
    await db.collection('drivers').updateOne({ _id: row._id }, { $set: patch }, { bypassDocumentValidation: true });
    count += 1;
  }
  logger.log?.(`[DB REPAIR] drivers updated: ${count}`);
  return count;
}

async function normalizeWallets(db, logger = console) {
  const cursor = db.collection('wallets').find({});
  let count = 0;
  while (await cursor.hasNext()) {
    const row = await cursor.next();
    const patch = {};
    const userId = toObjectId(row.userId);
    if (userId instanceof ObjectId) patch.userId = userId;
    patch.currency = 'VND';
    patch.balance = numberOr(row.balance, 0);
    patch.availableBalance = numberOr(row.availableBalance ?? row.balance, 0);
    patch.lockedBalance = numberOr(row.lockedBalance, 0);
    const type = String(row.type || '').toUpperCase();
    if (['CUSTOMER', 'DRIVER'].includes(type)) patch.type = type;
    else if (userId instanceof ObjectId) {
      const user = await db.collection('users').findOne({ _id: userId }, { projection: { roles: 1 } });
      patch.type = Array.isArray(user?.roles) && user.roles.includes('DRIVER') ? 'DRIVER' : 'CUSTOMER';
    } else patch.type = 'CUSTOMER';
    patch.updatedAt = new Date();
    await db.collection('wallets').updateOne({ _id: row._id }, { $set: patch }, { bypassDocumentValidation: true });
    count += 1;
  }
  logger.log?.(`[DB REPAIR] wallets updated: ${count}`);
  return count;
}

async function normalizeLoyalty(db, logger = console) {
  const cursor = db.collection('loyalty_accounts').find({});
  let count = 0;
  while (await cursor.hasNext()) {
    const row = await cursor.next();
    const patch = {
      balance: Math.trunc(numberOr(row.balance, 0)),
      lifetimeEarned: Math.trunc(numberOr(row.lifetimeEarned, 0)),
      lifetimeSpent: Math.trunc(numberOr(row.lifetimeSpent, 0)),
      updatedAt: new Date(),
    };
    const userId = toObjectId(row.userId);
    if (userId instanceof ObjectId) patch.userId = userId;
    await db.collection('loyalty_accounts').updateOne({ _id: row._id }, { $set: patch }, { bypassDocumentValidation: true });
    count += 1;
  }
  logger.log?.(`[DB REPAIR] loyalty_accounts updated: ${count}`);
  return count;
}


async function normalizeWalletTransactions(db, logger = console) {
  const cursor = db.collection('wallet_transactions').find({});
  let count = 0;
  const allowedTypes = new Set(['TRIP_EARNING','DRIVER_TRIP_EARNING','BOOKING_PAYMENT','DEMO_TOPUP','COMMISSION','ADJUSTMENT','TOPUP','WITHDRAWAL','REFUND','PENALTY','BONUS']);
  const allowedStatuses = new Set(['PENDING','COMPLETED','FAILED','CANCELLED']);
  while (await cursor.hasNext()) {
    const row = await cursor.next();
    const patch = {};
    for (const key of ['walletId','userId','driverId','bookingId']) {
      if (row[key] != null) {
        const value = toObjectId(row[key]);
        if (value instanceof ObjectId) patch[key] = value;
      }
    }
    const type = String(row.type || 'ADJUSTMENT').toUpperCase();
    patch.type = allowedTypes.has(type) ? type : 'ADJUSTMENT';
    const status = String(row.status || 'COMPLETED').toUpperCase();
    patch.status = allowedStatuses.has(status) ? status : 'COMPLETED';
    patch.amount = numberOr(row.amount, 0);
    if (row.balanceAfter != null) patch.balanceAfter = numberOr(row.balanceAfter, 0);
    patch.createdAt = toDate(row.createdAt, new Date());
    await db.collection('wallet_transactions').updateOne({ _id: row._id }, { $set: patch }, { bypassDocumentValidation: true });
    count += 1;
  }
  logger.log?.(`[DB REPAIR] wallet_transactions updated: ${count}`);
  return count;
}

async function normalizeLoyaltyTransactions(db, logger = console) {
  const cursor = db.collection('loyalty_transactions').find({});
  let count = 0;
  const allowedTypes = new Set(['WELCOME_BONUS','TRIP_REWARD','PROMOTION','REDEEM','ADJUSTMENT','REFUND','POINT_REVERSAL']);
  const allowedStatuses = new Set(['PENDING','COMPLETED','FAILED','CANCELLED']);
  while (await cursor.hasNext()) {
    const row = await cursor.next();
    const patch = {};
    for (const key of ['userId','bookingId']) {
      if (row[key] != null) {
        const value = toObjectId(row[key]);
        if (value instanceof ObjectId) patch[key] = value;
      }
    }
    const type = String(row.type || 'ADJUSTMENT').toUpperCase();
    patch.type = allowedTypes.has(type) ? type : 'ADJUSTMENT';
    const status = String(row.status || 'COMPLETED').toUpperCase();
    patch.status = allowedStatuses.has(status) ? status : 'COMPLETED';
    patch.points = Math.trunc(numberOr(row.points, 0));
    patch.balanceAfter = Math.trunc(numberOr(row.balanceAfter, 0));
    patch.createdAt = toDate(row.createdAt, new Date());
    await db.collection('loyalty_transactions').updateOne({ _id: row._id }, { $set: patch }, { bypassDocumentValidation: true });
    count += 1;
  }
  logger.log?.(`[DB REPAIR] loyalty_transactions updated: ${count}`);
  return count;
}

async function normalizePromotions(db, logger = console) {
  const cursor = db.collection('promotions').find({});
  let count = 0;
  while (await cursor.hasNext()) {
    const row = await cursor.next();
    const discountValue = Math.max(0, numberOr(row.discountValue ?? row.value, 0));
    const minOrderAmount = Math.max(0, numberOr(row.minOrderAmount ?? row.minOrderValue, 0));
    const totalUsageLimit = Math.max(0, Math.trunc(numberOr(row.totalUsageLimit ?? row.usageLimit, 0)));
    const startAt = toDate(row.startAt ?? row.startsAt, null);
    const endAt = toDate(row.endAt ?? row.endsAt, null);
    const patch = {
      code: String(row.code || '').trim().toUpperCase(),
      name: String(row.name || row.code || 'Khuyến mãi').trim(),
      discountType: ['FIXED','PERCENT'].includes(String(row.discountType||'PERCENT').toUpperCase()) ? String(row.discountType||'PERCENT').toUpperCase() : 'PERCENT',
      discountValue, value: discountValue,
      maxDiscount: Math.max(0, numberOr(row.maxDiscount, 0)),
      minOrderAmount, minOrderValue: minOrderAmount,
      serviceCodes: Array.isArray(row.serviceCodes) ? row.serviceCodes.map(x => String(x).toUpperCase()) : [],
      totalUsageLimit, usageLimit: totalUsageLimit,
      perUserLimit: Math.max(0, Math.trunc(numberOr(row.perUserLimit, 0))),
      newCustomerOnly: Boolean(row.newCustomerOnly),
      startAt, startsAt: startAt, endAt, endsAt: endAt,
      status: ['DRAFT','ACTIVE','INACTIVE','EXPIRED'].includes(String(row.status||'ACTIVE').toUpperCase()) ? String(row.status||'ACTIVE').toUpperCase() : 'ACTIVE',
      updatedAt: new Date(),
    };
    await db.collection('promotions').updateOne({ _id: row._id }, { $set: patch }, { bypassDocumentValidation: true });
    count += 1;
  }
  logger.log?.(`[DB REPAIR] promotions updated: ${count}`);
  return count;
}

async function ensureCollection(db, name, schema, logger = console) {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  const validator = { $jsonSchema: schema };
  if (!exists) {
    await db.createCollection(name, { validator, validationLevel: 'moderate', validationAction: 'error' });
    logger.log?.(`[DB REPAIR] created ${name}`);
    return;
  }
  await db.command({ collMod: name, validator, validationLevel: 'moderate', validationAction: 'error' });
  logger.log?.(`[DB REPAIR] validator ${name} -> 1.6.0`);
}


async function verifyCompletionWritePath({ db, client, logger = console } = {}) {
  if (!db || !client) return { ok: false, skipped: true, reason: 'missing_db_or_client' };
  const session = client.startSession();
  const now = new Date();
  const customerId = new ObjectId();
  const driverUserId = new ObjectId();
  const driverId = new ObjectId();
  const bookingId = new ObjectId();
  const walletId = new ObjectId();
  try {
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    await db.collection('drivers').insertOne({
      _id: driverId,
      userId: driverUserId,
      approvalStatus: 'APPROVED',
      onlineStatus: 'ONLINE',
      rating: 5,
      completedTrips: 0,
      cancelledTrips: 0,
      acceptanceRate: 100,
      createdAt: now,
      updatedAt: now,
    }, { session });
    await db.collection('bookings').insertOne({
      _id: bookingId,
      bookingCode: `VERIFY-${Date.now()}`,
      customerId,
      driverId,
      serviceCode: 'BIKE',
      status: 'COMPLETED',
      pickup: { address: 'verify', location: { type: 'Point', coordinates: [106.7, 10.77] } },
      destination: { address: 'verify', location: { type: 'Point', coordinates: [106.71, 10.78] } },
      pricing: { customerTotal: 10000, driverNetAmount: 8000 },
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    }, { session });
    await db.collection('loyalty_accounts').insertOne({
      userId: customerId,
      balance: 1,
      lifetimeEarned: 1,
      lifetimeSpent: 0,
      createdAt: now,
      updatedAt: now,
    }, { session });
    await db.collection('loyalty_transactions').insertOne({
      userId: customerId,
      bookingId,
      type: 'TRIP_REWARD',
      title: 'verify',
      points: 1,
      balanceAfter: 1,
      reference: `VERIFY-POINTS-${bookingId}`,
      status: 'COMPLETED',
      createdAt: now,
    }, { session });
    await db.collection('wallets').insertOne({
      _id: walletId,
      userId: driverUserId,
      type: 'DRIVER',
      currency: 'VND',
      balance: 8000,
      availableBalance: 8000,
      lockedBalance: 0,
      createdAt: now,
      updatedAt: now,
    }, { session });
    await db.collection('wallet_transactions').insertOne({
      walletId,
      userId: driverUserId,
      driverId,
      bookingId,
      type: 'DRIVER_TRIP_EARNING',
      title: 'verify',
      amount: 8000,
      balanceAfter: 8000,
      status: 'COMPLETED',
      reference: `VERIFY-TRIP-${bookingId}`,
      createdAt: now,
    }, { session });
    await session.abortTransaction();
    logger.log?.('[DB REPAIR] completion write-path verification PASS (transaction aborted)');
    return { ok: true, skipped: false };
  } catch (error) {
    try { if (session.inTransaction()) await session.abortTransaction(); } catch (_) {}
    error.message = `Completion write-path verification failed: ${error.message}`;
    throw error;
  } finally {
    await session.endSession();
  }
}


const DEFAULT_FARES_140 = {
  // 1.6.0 keeps this exported/legacy constant name for backward compatibility.
  // IMPORTANT: every code in DEFAULT_SERVICES must have a valid fare document,
  // otherwise MongoDB's fare_configs validator rejects the startup seed (code 121).
  BIKE:{
    baseFare:12000,baseDistanceKm:2,minimumFare:15000,pricePerMinute:250,
    distanceTiers:[{fromKm:0,toKm:2,pricePerKm:0},{fromKm:2,toKm:10,pricePerKm:4500},{fromKm:10,toKm:null,pricePerKm:4000}],
  },
  DELIVERY:{
    baseFare:15000,baseDistanceKm:2,minimumFare:18000,pricePerMinute:180,
    distanceTiers:[{fromKm:0,toKm:2,pricePerKm:0},{fromKm:2,toKm:10,pricePerKm:5000},{fromKm:10,toKm:null,pricePerKm:4500}],
  },
  ERRAND:{
    baseFare:18000,baseDistanceKm:2,minimumFare:22000,pricePerMinute:300,
    distanceTiers:[{fromKm:0,toKm:2,pricePerKm:0},{fromKm:2,toKm:10,pricePerKm:5500},{fromKm:10,toKm:null,pricePerKm:5000}],
  },
  FOOD:{
    baseFare:12000,baseDistanceKm:2,minimumFare:15000,pricePerMinute:150,
    distanceTiers:[{fromKm:0,toKm:2,pricePerKm:0},{fromKm:2,toKm:8,pricePerKm:4500},{fromKm:8,toKm:null,pricePerKm:4000}],
  },
  CAR_4:{baseFare:20000,baseDistanceKm:2,minimumFare:25000,pricePerMinute:450,distanceTiers:[{fromKm:2,toKm:null,pricePerKm:12000}]},
  CAR_7:{baseFare:28000,baseDistanceKm:2,minimumFare:35000,pricePerMinute:550,distanceTiers:[{fromKm:2,toKm:null,pricePerKm:15000}]},
  MPV_7:{baseFare:32000,baseDistanceKm:2,minimumFare:40000,pricePerMinute:600,distanceTiers:[{fromKm:2,toKm:null,pricePerKm:17000}]},
  LUXURY_4:{baseFare:38000,baseDistanceKm:2,minimumFare:50000,pricePerMinute:700,distanceTiers:[{fromKm:2,toKm:null,pricePerKm:20000}]},
  LUXURY_7:{baseFare:45000,baseDistanceKm:2,minimumFare:60000,pricePerMinute:800,distanceTiers:[{fromKm:2,toKm:null,pricePerKm:22000}]},
};
async function ensureV14CommercialData(db, logger=console){
  const now=new Date();
  for(const base of DEFAULT_SERVICES){
    await db.collection('service_catalog').updateOne({code:base.code},{$setOnInsert:{...base,status:'ACTIVE',matchingEnabled:true,customerVisible:true,createdAt:now},$set:{updatedAt:now}},{upsert:true});
    const existing=await db.collection('fare_configs').findOne({serviceCode:base.code,areaCode:'GLOBAL',status:'ACTIVE'});
    if(!existing){
      const fare=DEFAULT_FARES_140[base.code];
      if(!fare){
        throw new Error(`DEFAULT_FARE_MISSING: ${base.code}. Hãy khai báo bảng giá mặc định trước khi seed.`);
      }
      await db.collection('fare_configs').insertOne({
        serviceCode:base.code,
        areaCode:'GLOBAL',
        currency:'VND',
        ...fare,
        roundingUnit:1000,
        status:'ACTIVE',
        version:1,
        effectiveFrom:now,
        effectiveTo:null,
        source:'V1.6_DEFAULT_SEED',
        createdAt:now,
        updatedAt:now,
      });
      logger.log?.(`[DB REPAIR] fare_configs seeded: ${base.code}/GLOBAL`);
    }
    const fee=await db.collection('platform_fees').findOne({serviceCode:base.code,areaCode:'GLOBAL',status:'ACTIVE'});
    if(!fee)await db.collection('platform_fees').insertOne({serviceCode:base.code,areaCode:'GLOBAL',bookingFee:0,customerServiceFee:0,driverFixedFee:0,paymentFeePercent:0,driverCommission:{type:'PERCENT',value:20},status:'ACTIVE',version:1,effectiveFrom:now,effectiveTo:null,source:'V1.4_DEFAULT_SEED',createdAt:now,updatedAt:now});
  }
  await db.collection('vehicles').updateMany({serviceCodes:{$exists:false}},[{$set:{serviceCodes:{$cond:[{$and:[{$ne:['$serviceCode',null]},{$ne:['$serviceCode','']}]},['$serviceCode'],['BIKE']]},updatedAt:now}}]).catch(()=>{});
  await Promise.all([
    db.collection('service_catalog').createIndex({code:1},{unique:true,name:'uq_service_catalog_code'}),
    db.collection('service_catalog').createIndex({status:1,customerVisible:1,sortOrder:1},{name:'idx_service_catalog_visible'}),
    db.collection('fare_configs').createIndex({serviceCode:1,areaCode:1,status:1,effectiveFrom:-1,effectiveTo:1,version:-1},{name:'idx_fare_effective_v140'}),
    db.collection('platform_fees').createIndex({serviceCode:1,areaCode:1,status:1,effectiveFrom:-1,effectiveTo:1,version:-1},{name:'idx_platform_fee_effective_v140'}),
    db.collection('promotions').createIndex({code:1},{unique:true,name:'uq_promotions_code'}),
    db.collection('promotions').createIndex({status:1,startAt:1,endAt:1,serviceCodes:1},{name:'idx_promotions_eligibility'}),
    db.collection('promotion_redemptions').createIndex({bookingId:1,promotionId:1},{unique:true,name:'uq_promotion_booking'}),
    db.collection('promotion_redemptions').createIndex({promotionId:1,userId:1,status:1},{name:'idx_promotion_user_usage'}),
    db.collection('bookings').createIndex({serviceCode:1,status:1,completedAt:-1,createdAt:-1},{name:'idx_bookings_service_status_v140'}),
    db.collection('notifications').createIndex({targetId:1,level:1,createdAt:-1},{name:'idx_notifications_level_v140'}),
    db.collection('wallet_transactions').createIndex({bookingId:1,type:1,status:1},{name:'idx_wallet_settlement_retry_v140'}),
    db.collection('loyalty_transactions').createIndex({bookingId:1,type:1,status:1},{name:'idx_loyalty_settlement_retry_v140'}),
  ]);
  logger.log?.('[DB REPAIR] V1.6 catalog/pricing/promotions/indexes ready');
}


async function reconcileAdminBroadcastNotifications(db, logger = console) {
  const cursor = db.collection('notification_outbox').find({
    type: 'ADMIN_BROADCAST',
    targetId: { $exists: true, $ne: null },
  });
  let count = 0;
  while (await cursor.hasNext()) {
    const row = await cursor.next();
    const targetId = toObjectId(row.targetId);
    if (!(targetId instanceof ObjectId)) continue;
    const now = new Date();
    const targetType = String(row.targetType || 'CUSTOMER').toUpperCase();
    const patch = {
      userId: targetId,
      targetId,
      targetType,
      title: row.title == null ? 'TH79 iMove' : String(row.title),
      body: row.body == null ? '' : String(row.body),
      type: 'ADMIN_BROADCAST',
      data: row.data && typeof row.data === 'object' ? row.data : {},
      status: row.status || 'IN_APP',
      dedupeKey: row.dedupeKey || null,
      bookingId: toObjectId(row.bookingId) instanceof ObjectId ? toObjectId(row.bookingId) : null,
      offerId: toObjectId(row.offerId) instanceof ObjectId ? toObjectId(row.offerId) : null,
      broadcastId: toObjectId(row.broadcastId) instanceof ObjectId ? toObjectId(row.broadcastId) : null,
      level: Number.isFinite(Number(row.level)) ? Number(row.level) : 4,
      requireAck: Boolean(row.requireAck) || Number(row.level) === 1,
      expiresAt: toDate(row.expiresAt, null),
      sentAt: toDate(row.sentAt, null),
      deliveredAt: toDate(row.sentAt, null),
      updatedAt: now,
    };
    const filter = row.dedupeKey
      ? { dedupeKey: row.dedupeKey }
      : { broadcastId: patch.broadcastId, targetId, targetType };
    const result = await db.collection('notifications').updateOne(
      filter,
      {
        $set: patch,
        $setOnInsert: {
          readAt: null,
          openedAt: null,
          acknowledgedAt: null,
          createdAt: toDate(row.createdAt, now),
        },
      },
      { upsert: true },
    );
    if (result.upsertedCount || result.modifiedCount) count += 1;
  }
  logger.log?.(`[DB REPAIR] admin broadcast notifications reconciled: ${count}`);
  return count;
}

async function repairDatabase({ db, client = null, logger = console } = {}) {
  if (!db) throw new Error('repairDatabase cần MongoDB database instance.');
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name));
  const summary = { bookings: 0, drivers: 0, wallets: 0, walletTransactions: 0, loyaltyAccounts: 0, loyaltyTransactions: 0, promotions: 0, notificationBackfill: 0, validators: [] };
  if (existing.has('bookings')) summary.bookings = await normalizeBookings(db, logger);
  if (existing.has('drivers')) summary.drivers = await normalizeDrivers(db, logger);
  if (existing.has('wallets')) summary.wallets = await normalizeWallets(db, logger);
  if (existing.has('wallet_transactions')) summary.walletTransactions = await normalizeWalletTransactions(db, logger);
  if (existing.has('loyalty_accounts')) summary.loyaltyAccounts = await normalizeLoyalty(db, logger);
  if (existing.has('loyalty_transactions')) summary.loyaltyTransactions = await normalizeLoyaltyTransactions(db, logger);
  if (existing.has('promotions')) summary.promotions = await normalizePromotions(db, logger);
  for (const [name, schema] of Object.entries(schemas)) {
    await ensureCollection(db, name, schema, logger);
    summary.validators.push(name);
  }
  summary.notificationBackfill = await reconcileAdminBroadcastNotifications(db, logger);
  await ensureV14CommercialData(db, logger);
  await reconcileSystemRoles(db);
  await db.collection('app_settings').updateOne(
    { key: 'DATABASE_SCHEMA_VERSION' },
    { $set: { key: 'DATABASE_SCHEMA_VERSION', value: '1.6.0', status: 'ACTIVE', updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  if (client) summary.completionWritePath = await verifyCompletionWritePath({ db, client, logger });
  logger.log?.('[DB REPAIR] READY -> schema 1.6.0');
  return summary;
}

function completionCollectionForStep(step) {
  return ({
    BOOKING_COMMIT: 'bookings',
    BOOKING_VALIDATION: 'bookings',
    DRIVER_RELEASE: 'drivers',
    LOYALTY_SETTLEMENT: 'loyalty_accounts / loyalty_transactions',
    DRIVER_EARNING: 'wallets / wallet_transactions',
    PLATFORM_LEDGER: 'platform_ledger_entries / bookings',
  })[String(step || '')] || null;
}

function validationDetails(error) {
  return error?.errInfo?.details || error?.errInfo || null;
}

module.exports = {
  schemas,
  repairDatabase,
  normalizeBookings,
  normalizeDrivers,
  normalizeWallets,
  normalizeWalletTransactions,
  normalizeLoyalty,
  normalizeLoyaltyTransactions,
  normalizePromotions,
  reconcileAdminBroadcastNotifications,
  verifyCompletionWritePath,
  completionCollectionForStep,
  validationDetails,
  ensureV14CommercialData,
};
