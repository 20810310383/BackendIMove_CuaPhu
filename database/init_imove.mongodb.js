/**
 * TH79 iMove - MongoDB bootstrap script
 * Run with mongosh:
 *   mongosh "mongodb://127.0.0.1:27017" --file init_imove.mongodb.js
 *
 * Environment variables (optional):
 *   IMOVE_DB_NAME=th79_imove
 *   IMOVE_SEED_DEMO=true|false
 *   IMOVE_CREATE_DB_USER=true|false
 *   IMOVE_DB_USER=imove_app
 *   IMOVE_DB_PASSWORD=ChangeMe_StrongPassword
 *
 * Safe to run many times: collections/indexes/seeds use create-if-missing/upsert.
 */

const DB_NAME = process.env.IMOVE_DB_NAME || 'th79_imove';
const SEED_DEMO = String(process.env.IMOVE_SEED_DEMO || 'true').toLowerCase() !== 'false';
const CREATE_DB_USER = String(process.env.IMOVE_CREATE_DB_USER || 'false').toLowerCase() === 'true';
const DB_USER = process.env.IMOVE_DB_USER || 'imove_app';
const DB_PASSWORD = process.env.IMOVE_DB_PASSWORD || '';

const appDb = db.getSiblingDB(DB_NAME);
const now = new Date();

print('============================================================');
print(' TH79 iMove - MongoDB Setup');
print(` Database: ${DB_NAME}`);
print(` Seed demo data: ${SEED_DEMO}`);
print('============================================================');

function js(schema) {
  return { $jsonSchema: schema };
}

function ensureCollection(name, schema) {
  const exists = appDb.getCollectionInfos({ name }).length > 0;
  const validator = js(schema);
  if (!exists) {
    appDb.createCollection(name, {
      validator,
      validationLevel: 'moderate',
      validationAction: 'error',
    });
    print(`+ collection ${name}`);
  } else {
    const result = appDb.runCommand({
      collMod: name,
      validator,
      validationLevel: 'moderate',
      validationAction: 'error',
    });
    if (!result.ok) {
      print(`! could not update validator for ${name}: ${tojson(result)}`);
    }
  }
}

function ensureIndex(collection, keys, options = {}) {
  try {
    appDb.getCollection(collection).createIndex(keys, options);
  } catch (e) {
    print(`! index warning ${collection}: ${e.message}`);
  }
}

function seed(collection, filter, insertDoc, setDoc = {}) {
  appDb.getCollection(collection).updateOne(
    filter,
    {
      $setOnInsert: insertDoc,
      $set: { ...setDoc, updatedAt: now },
    },
    { upsert: true },
  );
}

const geoPointSchema = {
  bsonType: 'object',
  required: ['type', 'coordinates'],
  properties: {
    type: { enum: ['Point'] },
    coordinates: {
      bsonType: 'array',
      minItems: 2,
      maxItems: 2,
      items: { bsonType: ['double', 'int', 'long', 'decimal'] },
    },
  },
};

// ---------------------------------------------------------------------------
// 1) IDENTITY / AUTH / ADMIN
// ---------------------------------------------------------------------------
ensureCollection('users', {
  bsonType: 'object',
  required: ['phone', 'fullName', 'status', 'roles'],
  properties: {
    phone: { bsonType: 'string' },
    fullName: { bsonType: 'string' },
    email: { bsonType: ['string', 'null'] },
    passwordHash: { bsonType: ['string', 'null'] },
    avatarUrl: { bsonType: ['string', 'null'] },
    status: { enum: ['ACTIVE', 'INACTIVE', 'BLOCKED', 'DELETED'] },
    roles: { bsonType: 'array', items: { enum: ['CUSTOMER', 'DRIVER'] } },
    lastLoginAt: { bsonType: ['date', 'null'] },
    createdAt: { bsonType: ['date', 'null'] },
    updatedAt: { bsonType: ['date', 'null'] },
  },
});

ensureCollection('user_addresses', {
  bsonType: 'object',
  required: ['userId', 'label', 'location'],
  properties: {
    userId: { bsonType: 'objectId' },
    label: { bsonType: 'string' },
    addressText: { bsonType: ['string', 'null'] },
    location: geoPointSchema,
    isDefault: { bsonType: 'bool' },
  },
});

ensureCollection('admin_roles', {
  bsonType: 'object',
  required: ['code', 'name', 'permissions', 'status'],
  properties: {
    code: { bsonType: 'string' },
    name: { bsonType: 'string' },
    permissions: { bsonType: 'array', items: { bsonType: 'string' } },
    status: { enum: ['ACTIVE', 'INACTIVE'] },
  },
});

ensureCollection('admin_users', {
  bsonType: 'object',
  required: ['email', 'fullName', 'passwordHash', 'roleCodes', 'status'],
  properties: {
    email: { bsonType: 'string' },
    username: { bsonType: ['string', 'null'] },
    fullName: { bsonType: 'string' },
    phone: { bsonType: ['string', 'null'] },
    passwordHash: { bsonType: 'string' },
    roleCodes: { bsonType: 'array', items: { bsonType: 'string' } },
    status: { enum: ['ACTIVE', 'INACTIVE', 'LOCKED'] },
    mustChangePassword: { bsonType: 'bool' },
    failedLoginCount: { bsonType: ['int', 'long'] },
    lastLoginAt: { bsonType: ['date', 'null'] },
  },
});

ensureCollection('admin_sessions', {
  bsonType: 'object',
  required: ['adminUserId', 'tokenHash', 'expiresAt'],
  properties: {
    adminUserId: { bsonType: 'objectId' },
    tokenHash: { bsonType: 'string' },
    ip: { bsonType: ['string', 'null'] },
    userAgent: { bsonType: ['string', 'null'] },
    expiresAt: { bsonType: 'date' },
  },
});

ensureCollection('audit_logs', {
  bsonType: 'object',
  required: ['actorType', 'action', 'entityType', 'createdAt'],
  properties: {
    actorType: { enum: ['ADMIN', 'USER', 'DRIVER', 'SYSTEM'] },
    actorId: { bsonType: ['objectId', 'null'] },
    action: { bsonType: 'string' },
    entityType: { bsonType: 'string' },
    entityId: { bsonType: ['objectId', 'string', 'null'] },
    before: { bsonType: ['object', 'null'] },
    after: { bsonType: ['object', 'null'] },
    ip: { bsonType: ['string', 'null'] },
    createdAt: { bsonType: 'date' },
  },
});

// ---------------------------------------------------------------------------
// 2) DRIVER / VEHICLE / COMPLIANCE
// ---------------------------------------------------------------------------
ensureCollection('drivers', {
  bsonType: 'object',
  required: ['userId', 'approvalStatus', 'onlineStatus'],
  properties: {
    userId: { bsonType: 'objectId' },
    approvalStatus: { enum: ['DRAFT', 'OTP_PENDING', 'DOCUMENT_PENDING', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'] },
    onlineStatus: { enum: ['OFFLINE', 'ONLINE', 'BUSY'] },
    rating: { bsonType: ['double', 'int', 'decimal'] },
    completedTrips: { bsonType: ['int', 'long'] },
    cancelledTrips: { bsonType: ['int', 'long'] },
    acceptanceRate: { bsonType: ['double', 'int', 'decimal'] },
    approvedAt: { bsonType: ['date', 'null'] },
  },
});

ensureCollection('driver_documents', {
  bsonType: 'object',
  required: ['driverId', 'type', 'status'],
  properties: {
    driverId: { bsonType: 'objectId' },
    type: { enum: ['PORTRAIT', 'CCCD_FRONT', 'CCCD_BACK', 'DRIVING_LICENSE_FRONT', 'DRIVING_LICENSE_BACK', 'VEHICLE_REGISTRATION', 'INSURANCE', 'OTHER'] },
    fileUrl: { bsonType: ['string', 'null'] },
    number: { bsonType: ['string', 'null'] },
    issuedAt: { bsonType: ['date', 'null'] },
    expiresAt: { bsonType: ['date', 'null'] },
    status: { enum: ['MISSING', 'UPLOADED', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] },
    rejectReason: { bsonType: ['string', 'null'] },
    reviewedBy: { bsonType: ['objectId', 'null'] },
  },
});

ensureCollection('vehicles', {
  bsonType: 'object',
  required: ['driverId', 'serviceCode', 'plateNumber', 'status'],
  properties: {
    driverId: { bsonType: 'objectId' },
    serviceCode: { bsonType: 'string' },
    plateNumber: { bsonType: 'string' },
    brand: { bsonType: ['string', 'null'] },
    model: { bsonType: ['string', 'null'] },
    color: { bsonType: ['string', 'null'] },
    year: { bsonType: ['int', 'null'] },
    status: { enum: ['PENDING', 'APPROVED', 'REJECTED', 'INACTIVE'] },
  },
});

ensureCollection('driver_locations', {
  bsonType: 'object',
  required: ['driverId', 'location', 'updatedAt', 'expiresAt'],
  properties: {
    driverId: { bsonType: 'objectId' },
    location: geoPointSchema,
    heading: { bsonType: ['double', 'int', 'null'] },
    speedKph: { bsonType: ['double', 'int', 'null'] },
    accuracyM: { bsonType: ['double', 'int', 'null'] },
    updatedAt: { bsonType: 'date' },
    expiresAt: { bsonType: 'date' },
  },
});

// ---------------------------------------------------------------------------
// 3) SERVICES / AREAS / PRICING
// ---------------------------------------------------------------------------
ensureCollection('services', {
  bsonType: 'object',
  required: ['code', 'name', 'status'],
  properties: {
    code: { bsonType: 'string' },
    name: { bsonType: 'string' },
    description: { bsonType: ['string', 'null'] },
    iconKey: { bsonType: ['string', 'null'] },
    status: { enum: ['ACTIVE', 'INACTIVE', 'COMING_SOON'] },
    sortOrder: { bsonType: ['int', 'long'] },
  },
});

ensureCollection('service_areas', {
  bsonType: 'object',
  required: ['code', 'name', 'status'],
  properties: {
    code: { bsonType: 'string' },
    name: { bsonType: 'string' },
    provinceCode: { bsonType: ['string', 'null'] },
    center: { bsonType: ['object', 'null'] },
    boundary: { bsonType: ['object', 'null'] },
    enabledServices: { bsonType: 'array', items: { bsonType: 'string' } },
    status: { enum: ['ACTIVE', 'INACTIVE'] },
  },
});

ensureCollection('fare_configs', {
  bsonType: 'object',
  required: ['serviceCode', 'areaCode', 'version', 'status', 'currency', 'baseFare', 'baseDistanceKm', 'distanceTiers', 'minimumFare'],
  properties: {
    serviceCode: { bsonType: 'string' },
    areaCode: { bsonType: 'string' },
    version: { bsonType: ['int', 'long'] },
    status: { enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'] },
    currency: { enum: ['VND'] },
    baseFare: { bsonType: ['double', 'int', 'long', 'decimal'] },
    baseDistanceKm: { bsonType: ['double', 'int', 'decimal'] },
    minimumFare: { bsonType: ['double', 'int', 'long', 'decimal'] },
    pricePerMinute: { bsonType: ['double', 'int', 'long', 'decimal'] },
    roundingUnit: { bsonType: ['int', 'long'] },
    distanceTiers: {
      bsonType: 'array',
      items: {
        bsonType: 'object',
        required: ['fromKm', 'pricePerKm'],
        properties: {
          fromKm: { bsonType: ['double', 'int', 'decimal'] },
          toKm: { bsonType: ['double', 'int', 'decimal', 'null'] },
          pricePerKm: { bsonType: ['double', 'int', 'long', 'decimal'] },
        },
      },
    },
    effectiveFrom: { bsonType: ['date', 'null'] },
    effectiveTo: { bsonType: ['date', 'null'] },
    note: { bsonType: ['string', 'null'] },
    createdBy: { bsonType: ['objectId', 'null'] },
    approvedBy: { bsonType: ['objectId', 'null'] },
  },
});

ensureCollection('platform_fees', {
  bsonType: 'object',
  required: ['serviceCode', 'areaCode', 'version', 'status', 'driverCommission'],
  properties: {
    serviceCode: { bsonType: 'string' },
    areaCode: { bsonType: 'string' },
    version: { bsonType: ['int', 'long'] },
    status: { enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'] },
    bookingFee: { bsonType: ['double', 'int', 'long', 'decimal'] },
    customerServiceFee: { bsonType: ['double', 'int', 'long', 'decimal'] },
    driverFixedFee: { bsonType: ['double', 'int', 'long', 'decimal'] },
    paymentFeePercent: { bsonType: ['double', 'int', 'decimal'] },
    driverCommission: {
      bsonType: 'object',
      required: ['type', 'value'],
      properties: {
        type: { enum: ['PERCENT', 'FIXED'] },
        value: { bsonType: ['double', 'int', 'long', 'decimal'] },
      },
    },
    effectiveFrom: { bsonType: ['date', 'null'] },
    effectiveTo: { bsonType: ['date', 'null'] },
  },
});

ensureCollection('surcharges', {
  bsonType: 'object',
  required: ['code', 'name', 'serviceCode', 'calculationType', 'value', 'status'],
  properties: {
    code: { bsonType: 'string' },
    name: { bsonType: 'string' },
    serviceCode: { bsonType: 'string' },
    areaCodes: { bsonType: 'array', items: { bsonType: 'string' } },
    calculationType: { enum: ['FIXED', 'PERCENT', 'MULTIPLIER'] },
    value: { bsonType: ['double', 'int', 'long', 'decimal'] },
    conditions: { bsonType: ['object', 'null'] },
    status: { enum: ['ACTIVE', 'INACTIVE'] },
  },
});

ensureCollection('cancellation_policies', {
  bsonType: 'object',
  required: ['serviceCode', 'areaCode', 'version', 'status'],
  properties: {
    serviceCode: { bsonType: 'string' },
    areaCode: { bsonType: 'string' },
    version: { bsonType: ['int', 'long'] },
    freeCancellationSeconds: { bsonType: ['int', 'long'] },
    customerCancellationFee: { bsonType: ['double', 'int', 'long', 'decimal'] },
    driverCancellationPenalty: { bsonType: ['double', 'int', 'long', 'decimal'] },
    status: { enum: ['ACTIVE', 'INACTIVE'] },
  },
});

ensureCollection('promotions', {
  bsonType: 'object',
  required: ['code', 'name', 'discountType', 'discountValue', 'status'],
  properties: {
    code: { bsonType: 'string' },
    name: { bsonType: 'string' },
    discountType: { enum: ['FIXED', 'PERCENT'] },
    discountValue: { bsonType: ['double', 'int', 'long', 'decimal'] },
    value: { bsonType: ['double', 'int', 'long', 'decimal', 'null'] },
    maxDiscount: { bsonType: ['double', 'int', 'long', 'decimal', 'null'] },
    minOrderAmount: { bsonType: ['double', 'int', 'long', 'decimal', 'null'] },
    minOrderValue: { bsonType: ['double', 'int', 'long', 'decimal', 'null'] },
    serviceCodes: { bsonType: 'array', items: { bsonType: 'string' } },
    totalUsageLimit: { bsonType: ['double', 'int', 'long', 'decimal', 'null'] },
    usageLimit: { bsonType: ['double', 'int', 'long', 'decimal', 'null'] },
    perUserLimit: { bsonType: ['double', 'int', 'long', 'decimal', 'null'] },
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
});

ensureCollection('promo_usages', {
  bsonType: 'object',
  required: ['promotionId', 'userId', 'bookingId', 'usedAt'],
  properties: {
    promotionId: { bsonType: 'objectId' },
    userId: { bsonType: 'objectId' },
    bookingId: { bsonType: 'objectId' },
    usedAt: { bsonType: 'date' },
  },
});

// ---------------------------------------------------------------------------
// 4) BOOKING / DISPATCH / TRIP STATE
// ---------------------------------------------------------------------------
ensureCollection('bookings', {
  bsonType: 'object',
  required: ['bookingCode', 'customerId', 'serviceCode', 'status', 'pickup', 'destination', 'pricing', 'createdAt'],
  properties: {
    bookingCode: { bsonType: 'string' },
    customerId: { bsonType: 'objectId' },
    driverId: { bsonType: ['objectId', 'null'] },
    vehicleId: { bsonType: ['objectId', 'null'] },
    serviceCode: { bsonType: 'string' },
    areaCode: { bsonType: 'string' },
    status: { enum: ['DRAFT', 'SEARCHING', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CANCELLED_BY_USER', 'CANCELLED_BY_DRIVER', 'EXPIRED'] },
    pickup: {
      bsonType: 'object',
      required: ['location'],
      properties: {
        address: { bsonType: ['string', 'null'] },
        note: { bsonType: ['string', 'null'] },
        location: geoPointSchema,
      },
    },
    destination: {
      bsonType: 'object',
      required: ['location'],
      properties: {
        address: { bsonType: ['string', 'null'] },
        note: { bsonType: ['string', 'null'] },
        location: geoPointSchema,
      },
    },
    estimatedDistanceKm: { bsonType: ['double', 'int', 'decimal'] },
    estimatedDurationMinutes: { bsonType: ['double', 'int', 'decimal'] },
    actualDistanceKm: { bsonType: ['double', 'int', 'decimal', 'null'] },
    actualDurationMinutes: { bsonType: ['double', 'int', 'decimal', 'null'] },
    paymentMethod: { enum: ['CASH', 'BANK_TRANSFER', 'MOMO', 'VNPAY', 'WALLET'] },
    paymentStatus: { enum: ['UNPAID', 'PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'] },
    fareConfigVersion: { bsonType: ['int', 'long'] },
    platformFeeVersion: { bsonType: ['int', 'long'] },
    pricing: { bsonType: 'object' },
    cancellation: { bsonType: ['object', 'null'] },
    requestedAt: { bsonType: ['date', 'null'] },
    assignedAt: { bsonType: ['date', 'null'] },
    startedAt: { bsonType: ['date', 'null'] },
    completedAt: { bsonType: ['date', 'null'] },
    createdAt: { bsonType: 'date' },
    updatedAt: { bsonType: ['date', 'null'] },
  },
});

ensureCollection('booking_events', {
  bsonType: 'object',
  required: ['bookingId', 'type', 'createdAt'],
  properties: {
    bookingId: { bsonType: 'objectId' },
    type: { bsonType: 'string' },
    actorType: { enum: ['CUSTOMER', 'DRIVER', 'ADMIN', 'SYSTEM'] },
    actorId: { bsonType: ['objectId', 'null'] },
    payload: { bsonType: ['object', 'null'] },
    createdAt: { bsonType: 'date' },
  },
});

ensureCollection('driver_offers', {
  bsonType: 'object',
  required: ['bookingId', 'driverId', 'status', 'sentAt', 'expiresAt'],
  properties: {
    bookingId: { bsonType: 'objectId' },
    driverId: { bsonType: 'objectId' },
    distanceToPickupKm: { bsonType: ['double', 'int', 'decimal', 'null'] },
    status: { enum: ['SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'] },
    sentAt: { bsonType: 'date' },
    respondedAt: { bsonType: ['date', 'null'] },
    expiresAt: { bsonType: 'date' },
  },
});

// ---------------------------------------------------------------------------
// 5) PAYMENT / WALLET / SETTLEMENT
// ---------------------------------------------------------------------------
ensureCollection('payments', {
  bsonType: 'object',
  required: ['paymentCode', 'bookingId', 'amount', 'method', 'status'],
  properties: {
    paymentCode: { bsonType: 'string' },
    bookingId: { bsonType: 'objectId' },
    customerId: { bsonType: 'objectId' },
    amount: { bsonType: ['double', 'int', 'long', 'decimal'] },
    method: { enum: ['CASH', 'BANK_TRANSFER', 'MOMO', 'VNPAY', 'WALLET'] },
    provider: { bsonType: ['string', 'null'] },
    providerTransactionId: { bsonType: ['string', 'null'] },
    status: { enum: ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] },
    paidAt: { bsonType: ['date', 'null'] },
  },
});

ensureCollection('refunds', {
  bsonType: 'object',
  required: ['paymentId', 'amount', 'status'],
  properties: {
    paymentId: { bsonType: 'objectId' },
    bookingId: { bsonType: 'objectId' },
    amount: { bsonType: ['double', 'int', 'long', 'decimal'] },
    reason: { bsonType: ['string', 'null'] },
    status: { enum: ['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'] },
    processedBy: { bsonType: ['objectId', 'null'] },
  },
});

ensureCollection('driver_wallets', {
  bsonType: 'object',
  required: ['driverId', 'availableBalance', 'pendingBalance', 'currency'],
  properties: {
    driverId: { bsonType: 'objectId' },
    availableBalance: { bsonType: ['double', 'int', 'long', 'decimal'] },
    pendingBalance: { bsonType: ['double', 'int', 'long', 'decimal'] },
    debtBalance: { bsonType: ['double', 'int', 'long', 'decimal'] },
    currency: { enum: ['VND'] },
  },
});

ensureCollection('wallets', {
  bsonType: 'object',
  required: ['userId', 'type', 'currency', 'balance', 'availableBalance'],
  properties: {
    userId: { bsonType: 'objectId' },
    type: { enum: ['CUSTOMER', 'DRIVER'] },
    currency: { enum: ['VND'] },
    balance: { bsonType: ['double', 'int', 'long', 'decimal'] },
    availableBalance: { bsonType: ['double', 'int', 'long', 'decimal'] },
    lockedBalance: { bsonType: ['double', 'int', 'long', 'decimal'] },
    createdAt: { bsonType: ['date', 'null'] },
    updatedAt: { bsonType: ['date', 'null'] },
  },
});

ensureCollection('wallet_transactions', {
  bsonType: 'object',
  required: ['walletId', 'type', 'amount', 'status', 'createdAt'],
  properties: {
    walletId: { bsonType: 'objectId' },
    userId: { bsonType: ['objectId', 'null'] },
    driverId: { bsonType: ['objectId', 'null'] },
    bookingId: { bsonType: ['objectId', 'null'] },
    type: { enum: ['TRIP_EARNING', 'DRIVER_TRIP_EARNING', 'BOOKING_PAYMENT', 'DEMO_TOPUP', 'COMMISSION', 'ADJUSTMENT', 'TOPUP', 'WITHDRAWAL', 'REFUND', 'PENALTY', 'BONUS'] },
    title: { bsonType: ['string', 'null'] },
    amount: { bsonType: ['double', 'int', 'long', 'decimal'] },
    balanceAfter: { bsonType: ['double', 'int', 'long', 'decimal', 'null'] },
    status: { enum: ['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'] },
    reference: { bsonType: ['string', 'null'] },
    seedTag: { bsonType: ['string', 'null'] },
    createdAt: { bsonType: 'date' },
  },
});

ensureCollection('loyalty_accounts', {
  bsonType: 'object',
  required: ['userId', 'balance', 'lifetimeEarned', 'lifetimeSpent'],
  properties: {
    userId: { bsonType: 'objectId' },
    balance: { bsonType: ['double', 'int', 'long', 'decimal'] },
    lifetimeEarned: { bsonType: ['double', 'int', 'long', 'decimal'] },
    lifetimeSpent: { bsonType: ['double', 'int', 'long', 'decimal'] },
    createdAt: { bsonType: ['date', 'null'] },
    updatedAt: { bsonType: ['date', 'null'] },
  },
});

ensureCollection('loyalty_transactions', {
  bsonType: 'object',
  required: ['userId', 'type', 'points', 'status', 'createdAt'],
  properties: {
    userId: { bsonType: 'objectId' },
    bookingId: { bsonType: ['objectId', 'null'] },
    type: { enum: ['WELCOME_BONUS', 'TRIP_REWARD', 'PROMOTION', 'REDEEM', 'ADJUSTMENT', 'REFUND'] },
    title: { bsonType: ['string', 'null'] },
    points: { bsonType: ['double', 'int', 'long', 'decimal'] },
    balanceAfter: { bsonType: ['double', 'int', 'long', 'decimal'] },
    reference: { bsonType: ['string', 'null'] },
    status: { enum: ['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'] },
    seedTag: { bsonType: ['string', 'null'] },
    createdAt: { bsonType: 'date' },
  },
});

ensureCollection('settlements', {
  bsonType: 'object',
  required: ['settlementCode', 'driverId', 'grossAmount', 'netAmount', 'status'],
  properties: {
    settlementCode: { bsonType: 'string' },
    driverId: { bsonType: 'objectId' },
    periodFrom: { bsonType: ['date', 'null'] },
    periodTo: { bsonType: ['date', 'null'] },
    grossAmount: { bsonType: ['double', 'int', 'long', 'decimal'] },
    commissionAmount: { bsonType: ['double', 'int', 'long', 'decimal'] },
    adjustmentAmount: { bsonType: ['double', 'int', 'long', 'decimal'] },
    netAmount: { bsonType: ['double', 'int', 'long', 'decimal'] },
    status: { enum: ['DRAFT', 'PENDING', 'PAID', 'FAILED', 'CANCELLED'] },
    paidAt: { bsonType: ['date', 'null'] },
  },
});

ensureCollection('webhook_logs', {
  bsonType: 'object',
  required: ['provider', 'eventType', 'receivedAt'],
  properties: {
    provider: { bsonType: 'string' },
    eventType: { bsonType: 'string' },
    payload: { bsonType: ['object', 'array', 'string', 'null'] },
    processed: { bsonType: 'bool' },
    receivedAt: { bsonType: 'date' },
  },
});

// ---------------------------------------------------------------------------
// 6) RATING / NOTIFICATION / SUPPORT
// ---------------------------------------------------------------------------
ensureCollection('ratings', {
  bsonType: 'object',
  required: ['bookingId', 'fromUserId', 'toUserId', 'score'],
  properties: {
    bookingId: { bsonType: 'objectId' },
    fromUserId: { bsonType: 'objectId' },
    toUserId: { bsonType: 'objectId' },
    score: { bsonType: ['int', 'long'], minimum: 1, maximum: 5 },
    comment: { bsonType: ['string', 'null'] },
    tags: { bsonType: 'array', items: { bsonType: 'string' } },
  },
});

ensureCollection('notifications', {
  bsonType: 'object',
  properties: {
    userId: { bsonType: ['objectId', 'null'] },
    targetId: { bsonType: ['objectId', 'null'] },
    targetType: { enum: ['CUSTOMER', 'DRIVER', 'ADMIN', null] },
    title: { bsonType: 'string' },
    body: { bsonType: 'string' },
    type: { bsonType: ['string', 'null'] },
    data: { bsonType: ['object', 'null'] },
    status: { bsonType: ['string', 'null'] },
    dedupeKey: { bsonType: ['string', 'null'] },
    broadcastId: { bsonType: ['objectId', 'null'] },
    level: { bsonType: ['int', 'long', 'double', 'null'] },
    requireAck: { bsonType: ['bool', 'null'] },
    expiresAt: { bsonType: ['date', 'null'] },
    readAt: { bsonType: ['date', 'null'] },
    acknowledgedAt: { bsonType: ['date', 'null'] },
    createdAt: { bsonType: ['date', 'null'] },
    updatedAt: { bsonType: ['date', 'null'] },
  },
});

ensureCollection('device_tokens', {
  bsonType: 'object',
  required: ['userId', 'token', 'platform'],
  properties: {
    userId: { bsonType: 'objectId' },
    token: { bsonType: 'string' },
    platform: { enum: ['ANDROID', 'IOS', 'WEB', 'UNKNOWN'] },
    userType: { enum: ['CUSTOMER', 'DRIVER', 'ADMIN', null] },
    appType: { enum: ['USER', 'DRIVER', 'ADMIN', null] },
    deviceId: { bsonType: ['string', 'null'] },
    appVersion: { bsonType: ['string', 'null'] },
    enabled: { bsonType: ['bool', 'null'] },
    active: { bsonType: ['bool', 'null'] },
    lastSeenAt: { bsonType: ['date', 'null'] },
    createdAt: { bsonType: ['date', 'null'] },
    updatedAt: { bsonType: ['date', 'null'] },
  },
});

ensureCollection('support_tickets', {
  bsonType: 'object',
  required: ['ticketCode', 'requesterType', 'subject', 'status', 'priority'],
  properties: {
    ticketCode: { bsonType: 'string' },
    requesterType: { enum: ['CUSTOMER', 'DRIVER'] },
    requesterId: { bsonType: 'objectId' },
    bookingId: { bsonType: ['objectId', 'null'] },
    subject: { bsonType: 'string' },
    category: { bsonType: ['string', 'null'] },
    status: { enum: ['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED'] },
    priority: { enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
    assignedAdminId: { bsonType: ['objectId', 'null'] },
  },
});

ensureCollection('support_messages', {
  bsonType: 'object',
  required: ['ticketId', 'senderType', 'message', 'createdAt'],
  properties: {
    ticketId: { bsonType: 'objectId' },
    senderType: { enum: ['CUSTOMER', 'DRIVER', 'ADMIN', 'SYSTEM'] },
    senderId: { bsonType: ['objectId', 'null'] },
    message: { bsonType: 'string' },
    attachments: { bsonType: 'array' },
    createdAt: { bsonType: 'date' },
  },
});

// ---------------------------------------------------------------------------
// 7) SYSTEM CONFIG / ADMIN-CONTROLLED SETTINGS
// ---------------------------------------------------------------------------
ensureCollection('app_settings', {
  bsonType: 'object',
  required: ['key', 'value', 'status'],
  properties: {
    key: { bsonType: 'string' },
    value: {},
    description: { bsonType: ['string', 'null'] },
    status: { enum: ['ACTIVE', 'INACTIVE'] },
  },
});

ensureCollection('payment_settings', {
  bsonType: 'object',
  required: ['code', 'name', 'enabled'],
  properties: {
    code: { bsonType: 'string' },
    name: { bsonType: 'string' },
    enabled: { bsonType: 'bool' },
    config: { bsonType: ['object', 'null'] },
    sortOrder: { bsonType: ['int', 'long'] },
  },
});

ensureCollection('feature_flags', {
  bsonType: 'object',
  required: ['key', 'enabled'],
  properties: {
    key: { bsonType: 'string' },
    enabled: { bsonType: 'bool' },
    description: { bsonType: ['string', 'null'] },
    rolloutPercent: { bsonType: ['int', 'long'], minimum: 0, maximum: 100 },
  },
});

ensureCollection('system_counters', {
  bsonType: 'object',
  required: ['key', 'seq'],
  properties: {
    key: { bsonType: 'string' },
    seq: { bsonType: ['int', 'long'] },
  },
});

// ---------------------------------------------------------------------------
// INDEXES
// ---------------------------------------------------------------------------
ensureIndex('users', { phone: 1 }, { unique: true, name: 'uq_users_phone' });
ensureIndex('users', { email: 1 }, { sparse: true, name: 'idx_users_email' });
ensureIndex('users', { status: 1, createdAt: -1 }, { name: 'idx_users_status_created' });
ensureIndex('user_addresses', { userId: 1 }, { name: 'idx_addresses_user' });
ensureIndex('user_addresses', { location: '2dsphere' }, { name: 'geo_addresses_location' });
ensureIndex('admin_roles', { code: 1 }, { unique: true, name: 'uq_admin_roles_code' });
ensureIndex('admin_users', { email: 1 }, { unique: true, name: 'uq_admin_users_email' });
ensureIndex('admin_users', { username: 1 }, { unique: true, sparse: true, name: 'uq_admin_users_username' });
ensureIndex('admin_sessions', { expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_admin_sessions' });
ensureIndex('audit_logs', { entityType: 1, entityId: 1, createdAt: -1 }, { name: 'idx_audit_entity' });
ensureIndex('audit_logs', { actorType: 1, actorId: 1, createdAt: -1 }, { name: 'idx_audit_actor' });

ensureIndex('drivers', { userId: 1 }, { unique: true, name: 'uq_drivers_user' });
ensureIndex('drivers', { approvalStatus: 1, onlineStatus: 1 }, { name: 'idx_drivers_status_online' });
ensureIndex('driver_documents', { driverId: 1, type: 1 }, { unique: true, name: 'uq_driver_document_type' });
ensureIndex('vehicles', { plateNumber: 1 }, { unique: true, name: 'uq_vehicles_plate' });
ensureIndex('vehicles', { driverId: 1, status: 1 }, { name: 'idx_vehicles_driver' });
ensureIndex('driver_locations', { driverId: 1 }, { unique: true, name: 'uq_driver_locations_driver' });
ensureIndex('driver_locations', { location: '2dsphere' }, { name: 'geo_driver_locations' });
ensureIndex('driver_locations', { expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_driver_locations' });

ensureIndex('services', { code: 1 }, { unique: true, name: 'uq_services_code' });
ensureIndex('service_areas', { code: 1 }, { unique: true, name: 'uq_service_areas_code' });
ensureIndex('service_areas', { boundary: '2dsphere' }, { sparse: true, name: 'geo_service_areas_boundary' });
ensureIndex('fare_configs', { serviceCode: 1, areaCode: 1, version: -1 }, { unique: true, name: 'uq_fare_version' });
ensureIndex('fare_configs', { serviceCode: 1, areaCode: 1, status: 1, effectiveFrom: -1 }, { name: 'idx_fare_active_lookup' });
ensureIndex('platform_fees', { serviceCode: 1, areaCode: 1, version: -1 }, { unique: true, name: 'uq_platform_fee_version' });
ensureIndex('platform_fees', { serviceCode: 1, areaCode: 1, status: 1 }, { name: 'idx_platform_fee_active' });
ensureIndex('surcharges', { code: 1 }, { unique: true, name: 'uq_surcharges_code' });
ensureIndex('cancellation_policies', { serviceCode: 1, areaCode: 1, version: -1 }, { unique: true, name: 'uq_cancel_policy_version' });
ensureIndex('promotions', { code: 1 }, { unique: true, name: 'uq_promotions_code' });
ensureIndex('promo_usages', { promotionId: 1, userId: 1, usedAt: -1 }, { name: 'idx_promo_usage' });

ensureIndex('bookings', { bookingCode: 1 }, { unique: true, name: 'uq_bookings_code' });
ensureIndex('bookings', { customerId: 1, createdAt: -1 }, { name: 'idx_bookings_customer' });
ensureIndex('bookings', { driverId: 1, createdAt: -1 }, { name: 'idx_bookings_driver' });
ensureIndex('bookings', { status: 1, createdAt: -1 }, { name: 'idx_bookings_status' });
ensureIndex('bookings', { 'pickup.location': '2dsphere' }, { name: 'geo_bookings_pickup' });
ensureIndex('bookings', { 'destination.location': '2dsphere' }, { name: 'geo_bookings_destination' });
ensureIndex('booking_events', { bookingId: 1, createdAt: 1 }, { name: 'idx_booking_events_timeline' });
ensureIndex('driver_offers', { bookingId: 1, driverId: 1 }, { unique: true, name: 'uq_driver_offer_booking_driver' });
ensureIndex('driver_offers', { driverId: 1, status: 1, sentAt: -1 }, { name: 'idx_driver_offers_driver' });
ensureIndex('driver_offers', { expiresAt: 1 }, { expireAfterSeconds: 86400, name: 'ttl_driver_offers_history_1d' });

ensureIndex('payments', { paymentCode: 1 }, { unique: true, name: 'uq_payments_code' });
ensureIndex('payments', { bookingId: 1 }, { name: 'idx_payments_booking' });
ensureIndex('driver_wallets', { driverId: 1 }, { unique: true, name: 'uq_wallet_driver' });
ensureIndex('wallets', { userId: 1 }, { unique: true, name: 'uq_wallet_user' });
ensureIndex('wallet_transactions', { userId: 1, createdAt: -1 }, { name: 'idx_wallet_tx_user' });
ensureIndex('wallet_transactions', { driverId: 1, createdAt: -1 }, { name: 'idx_wallet_tx_driver' });
ensureIndex('loyalty_accounts', { userId: 1 }, { unique: true, name: 'uq_loyalty_user' });
ensureIndex('loyalty_transactions', { userId: 1, createdAt: -1 }, { name: 'idx_loyalty_user_created' });
ensureIndex('wallet_transactions', { bookingId: 1 }, { sparse: true, name: 'idx_wallet_tx_booking' });
ensureIndex('settlements', { settlementCode: 1 }, { unique: true, name: 'uq_settlements_code' });
ensureIndex('settlements', { driverId: 1, periodTo: -1 }, { name: 'idx_settlements_driver_period' });
ensureIndex('webhook_logs', { provider: 1, receivedAt: -1 }, { name: 'idx_webhooks_provider' });

ensureIndex('ratings', { bookingId: 1, fromUserId: 1 }, { unique: true, name: 'uq_rating_booking_from' });
ensureIndex('ratings', { toUserId: 1, createdAt: -1 }, { name: 'idx_ratings_to_user' });
ensureIndex('notifications', { userId: 1, status: 1, createdAt: -1 }, { name: 'idx_notifications_user' });
ensureIndex('device_tokens', { token: 1 }, { unique: true, name: 'uq_device_token' });
ensureIndex('device_tokens', { userId: 1, appType: 1, active: 1 }, { name: 'idx_device_tokens_user' });
ensureIndex('support_tickets', { ticketCode: 1 }, { unique: true, name: 'uq_support_ticket_code' });
ensureIndex('support_tickets', { status: 1, priority: 1, createdAt: -1 }, { name: 'idx_support_queue' });
ensureIndex('support_messages', { ticketId: 1, createdAt: 1 }, { name: 'idx_support_messages_timeline' });

ensureIndex('app_settings', { key: 1 }, { unique: true, name: 'uq_app_settings_key' });
ensureIndex('payment_settings', { code: 1 }, { unique: true, name: 'uq_payment_settings_code' });
ensureIndex('feature_flags', { key: 1 }, { unique: true, name: 'uq_feature_flags_key' });
ensureIndex('system_counters', { key: 1 }, { unique: true, name: 'uq_system_counters_key' });

// ---------------------------------------------------------------------------
// SEED: ADMIN ROLES & BOOTSTRAP ADMIN
// ---------------------------------------------------------------------------
const ALL_PERMISSIONS = [
  'dashboard.view',
  'users.view', 'users.update', 'users.block',
  'drivers.view', 'drivers.review', 'drivers.approve', 'drivers.suspend',
  'vehicles.view', 'vehicles.review',
  'bookings.view', 'bookings.cancel', 'bookings.adjust',
  'pricing.view', 'pricing.create', 'pricing.activate', 'pricing.archive',
  'fees.view', 'fees.manage',
  'promotions.view', 'promotions.manage',
  'payments.view', 'payments.refund',
  'wallets.view', 'wallets.adjust',
  'settlements.view', 'settlements.manage',
  'support.view', 'support.assign', 'support.reply', 'support.close',
  'settings.view', 'settings.manage',
  'reports.view',
  'audit.view',
  'admins.view', 'admins.manage', 'roles.manage',
];

const roles = [
  ['SUPER_ADMIN', 'Quản trị tối cao', ALL_PERMISSIONS],
  ['OPERATIONS', 'Vận hành', ['dashboard.view', 'users.view', 'drivers.view', 'drivers.review', 'drivers.approve', 'vehicles.view', 'vehicles.review', 'bookings.view', 'bookings.cancel', 'support.view', 'reports.view']],
  ['DRIVER_REVIEW', 'Duyệt tài xế', ['dashboard.view', 'drivers.view', 'drivers.review', 'drivers.approve', 'drivers.suspend', 'vehicles.view', 'vehicles.review']],
  ['PRICING_MANAGER', 'Quản lý giá cước', ['dashboard.view', 'pricing.view', 'pricing.create', 'pricing.activate', 'pricing.archive', 'fees.view', 'fees.manage', 'promotions.view', 'promotions.manage', 'audit.view']],
  ['FINANCE', 'Kế toán - tài chính', ['dashboard.view', 'bookings.view', 'payments.view', 'payments.refund', 'wallets.view', 'wallets.adjust', 'settlements.view', 'settlements.manage', 'reports.view']],
  ['SUPPORT', 'Chăm sóc khách hàng', ['dashboard.view', 'users.view', 'drivers.view', 'bookings.view', 'support.view', 'support.assign', 'support.reply', 'support.close']],
  ['VIEWER', 'Chỉ xem', ['dashboard.view', 'users.view', 'drivers.view', 'bookings.view', 'pricing.view', 'fees.view', 'payments.view', 'reports.view']],
];

for (const [code, name, permissions] of roles) {
  seed('admin_roles', { code }, { code, name, permissions, status: 'ACTIVE', createdAt: now }, { name, permissions, status: 'ACTIVE' });
}

// Bootstrap admin for LOCAL/DEMO only. Password: Admin@123456
// Hash is bcrypt; production backend must force password change immediately.
seed(
  'admin_users',
  { email: 'admin@th79.vn' },
  {
    email: 'admin@th79.vn',
    username: 'admin',
    fullName: 'TH79 Super Admin',
    phone: null,
    passwordHash: '$2y$12$tp.ghZXjPI1kkk5TO6VAl.3hnLTmiM/K1CdT/NskgmgIBWAlZuv.e',
    roleCodes: ['SUPER_ADMIN'],
    status: 'ACTIVE',
    mustChangePassword: true,
    failedLoginCount: NumberInt(0),
    lastLoginAt: null,
    createdAt: now,
  },
  {},
);

// ---------------------------------------------------------------------------
// SEED: SERVICE / AREA / PRICING / FEES / SETTINGS
// ---------------------------------------------------------------------------
seed('services', { code: 'BIKE' }, {
  code: 'BIKE',
  name: 'Xe máy',
  description: 'Dịch vụ đặt xe máy TH79 iMove',
  iconKey: 'bike',
  status: 'ACTIVE',
  sortOrder: NumberInt(1),
  createdAt: now,
}, { status: 'ACTIVE' });

seed('service_areas', { code: 'GLOBAL' }, {
  code: 'GLOBAL',
  name: 'Mặc định toàn hệ thống',
  provinceCode: null,
  center: null,
  boundary: null,
  enabledServices: ['BIKE'],
  status: 'ACTIVE',
  createdAt: now,
}, {});

seed('service_areas', { code: 'HCM' }, {
  code: 'HCM',
  name: 'TP. Hồ Chí Minh',
  provinceCode: '79',
  center: { type: 'Point', coordinates: [106.6297, 10.8231] },
  boundary: null,
  enabledServices: ['BIKE'],
  status: 'ACTIVE',
  createdAt: now,
}, {});

seed('fare_configs', { serviceCode: 'BIKE', areaCode: 'GLOBAL', version: NumberInt(1) }, {
  serviceCode: 'BIKE',
  areaCode: 'GLOBAL',
  version: NumberInt(1),
  status: 'ACTIVE',
  currency: 'VND',
  baseFare: NumberLong(12000),
  baseDistanceKm: 2.0,
  minimumFare: NumberLong(15000),
  pricePerMinute: NumberLong(250),
  roundingUnit: NumberInt(1000),
  distanceTiers: [
    { fromKm: 0.0, toKm: 2.0, pricePerKm: NumberLong(0) },
    { fromKm: 2.0, toKm: 10.0, pricePerKm: NumberLong(4500) },
    { fromKm: 10.0, toKm: null, pricePerKm: NumberLong(4000) },
  ],
  effectiveFrom: new Date('2026-09-01T00:00:00+07:00'),
  effectiveTo: null,
  note: 'Bảng giá BIKE mặc định v1 - chỉnh qua Admin Web ở giai đoạn sau',
  createdBy: null,
  approvedBy: null,
  createdAt: now,
}, {});

seed('platform_fees', { serviceCode: 'BIKE', areaCode: 'GLOBAL', version: NumberInt(1) }, {
  serviceCode: 'BIKE',
  areaCode: 'GLOBAL',
  version: NumberInt(1),
  status: 'ACTIVE',
  bookingFee: NumberLong(2000),
  customerServiceFee: NumberLong(1000),
  driverFixedFee: NumberLong(0),
  paymentFeePercent: 0.0,
  driverCommission: { type: 'PERCENT', value: 20.0 },
  effectiveFrom: new Date('2026-09-01T00:00:00+07:00'),
  effectiveTo: null,
  createdAt: now,
}, {});

const surchargeSeeds = [
  ['RAIN', 'Phụ phí thời tiết', 'FIXED', 5000, 'INACTIVE'],
  ['PEAK_HOUR', 'Phụ phí giờ cao điểm', 'MULTIPLIER', 1.2, 'INACTIVE'],
  ['NIGHT', 'Phụ phí ban đêm', 'FIXED', 5000, 'INACTIVE'],
  ['HOLIDAY', 'Phụ phí ngày lễ', 'PERCENT', 20, 'INACTIVE'],
];
for (const [code, name, calculationType, value, status] of surchargeSeeds) {
  seed('surcharges', { code }, {
    code, name, serviceCode: 'BIKE', areaCodes: ['GLOBAL'], calculationType, value,
    conditions: null, status, createdAt: now,
  }, {});
}

seed('cancellation_policies', { serviceCode: 'BIKE', areaCode: 'GLOBAL', version: NumberInt(1) }, {
  serviceCode: 'BIKE',
  areaCode: 'GLOBAL',
  version: NumberInt(1),
  freeCancellationSeconds: NumberInt(120),
  customerCancellationFee: NumberLong(5000),
  driverCancellationPenalty: NumberLong(10000),
  status: 'ACTIVE',
  createdAt: now,
}, {});

seed('app_settings', { key: 'BIKE_BOOKING_CONFIG' }, {
  key: 'BIKE_BOOKING_CONFIG',
  value: {
    initialSearchRadiusKm: 3.0,
    maxSearchRadiusKm: 10.0,
    radiusExpansionStepKm: 2.0,
    driverAcceptSeconds: NumberInt(20),
    bookingTimeoutSeconds: NumberInt(300),
    offersPerBatch: NumberInt(5),
    allowScheduleBooking: false,
    allowCash: true,
    allowBankTransfer: false,
    autoCancelIfNoDriver: true,
  },
  description: 'Cấu hình điều phối chuyến BIKE. Admin Web có thể chỉnh sau.',
  status: 'ACTIVE',
  createdAt: now,
}, {});

seed('app_settings', { key: 'USER_APP_CONFIG' }, {
  key: 'USER_APP_CONFIG',
  value: {
    minimumSupportedVersion: '1.0.0',
    maintenanceMode: false,
    customerSupportPhone: '0335555066',
    showPromotions: true,
  },
  description: 'Cấu hình từ xa cho TH79 iMove',
  status: 'ACTIVE',
  createdAt: now,
}, {});

seed('app_settings', { key: 'DRIVER_APP_CONFIG' }, {
  key: 'DRIVER_APP_CONFIG',
  value: {
    minimumSupportedVersion: '1.0.0',
    maintenanceMode: false,
    locationUpdateSecondsOnline: NumberInt(5),
    locationUpdateSecondsOnTrip: NumberInt(3),
    requireApprovedDocuments: true,
  },
  description: 'Cấu hình từ xa cho iMove Driver',
  status: 'ACTIVE',
  createdAt: now,
}, {});

const paymentMethods = [
  ['CASH', 'Tiền mặt', true, 1],
  ['BANK_TRANSFER', 'Chuyển khoản', false, 2],
  ['MOMO', 'MoMo', false, 3],
  ['VNPAY', 'VNPay', false, 4],
  ['WALLET', 'Ví iMove', false, 5],
];
for (const [code, name, enabled, sortOrder] of paymentMethods) {
  seed('payment_settings', { code }, {
    code, name, enabled, config: null, sortOrder: NumberInt(sortOrder), createdAt: now,
  }, {});
}

const flags = [
  ['BIKE_ENABLED', true, 'Bật/tắt dịch vụ xe máy'],
  ['PROMOTION_ENABLED', true, 'Bật/tắt mã khuyến mãi'],
  ['SURGE_ENABLED', false, 'Bật/tắt giá động'],
  ['SCHEDULE_BOOKING_ENABLED', false, 'Đặt chuyến trước'],
  ['CUSTOMER_WALLET_ENABLED', false, 'Ví khách hàng'],
];
for (const [key, enabled, description] of flags) {
  seed('feature_flags', { key }, {
    key, enabled, description, rolloutPercent: NumberInt(100), createdAt: now,
  }, {});
}

for (const key of ['BOOKING', 'PAYMENT', 'SETTLEMENT', 'SUPPORT_TICKET']) {
  seed('system_counters', { key }, { key, seq: NumberLong(0), createdAt: now }, {});
}

// ---------------------------------------------------------------------------
// OPTIONAL DEMO ACCOUNTS / DRIVER
// ---------------------------------------------------------------------------
if (SEED_DEMO) {
  seed('users', { phone: '0335555066' }, {
    phone: '0335555066',
    fullName: 'Khách hàng Demo',
    email: 'customer.demo@th79.vn',
    passwordHash: '$2y$12$sp0EvyMTNMGCMAHy1EcgYOyIqSn.52QWo/AQmhGJdPdCZvjccQzXe',
    avatarUrl: null,
    status: 'ACTIVE',
    roles: ['CUSTOMER'],
    lastLoginAt: null,
    createdAt: now,
  }, {});

  seed('users', { phone: '0909000001' }, {
    phone: '0909000001',
    fullName: 'Tài xế Demo',
    email: 'driver.demo@th79.vn',
    passwordHash: '$2y$12$qtFSOkgn0l9asAx7xa6a..PLIGNMuf6nMojG8LG1p15WKHNFW2uFq',
    avatarUrl: null,
    status: 'ACTIVE',
    roles: ['DRIVER'],
    lastLoginAt: null,
    createdAt: now,
  }, {});

  const driverUser = appDb.users.findOne({ phone: '0909000001' });
  seed('drivers', { userId: driverUser._id }, {
    userId: driverUser._id,
    approvalStatus: 'APPROVED',
    onlineStatus: 'OFFLINE',
    rating: 5.0,
    completedTrips: NumberInt(0),
    cancelledTrips: NumberInt(0),
    acceptanceRate: 100.0,
    approvedAt: now,
    createdAt: now,
  }, {});

  const driver = appDb.drivers.findOne({ userId: driverUser._id });
  seed('vehicles', { plateNumber: '59X1-123.45' }, {
    driverId: driver._id,
    serviceCode: 'BIKE',
    plateNumber: '59X1-123.45',
    brand: 'Honda',
    model: 'Wave Alpha',
    color: 'Đen',
    year: NumberInt(2025),
    status: 'APPROVED',
    createdAt: now,
  }, {});

  seed('driver_wallets', { driverId: driver._id }, {
    driverId: driver._id,
    availableBalance: NumberLong(0),
    pendingBalance: NumberLong(0),
    debtBalance: NumberLong(0),
    currency: 'VND',
    createdAt: now,
  }, {});
}

// ---------------------------------------------------------------------------
// OPTIONAL DB APPLICATION USER
// ---------------------------------------------------------------------------
if (CREATE_DB_USER) {
  if (!DB_PASSWORD) {
    print('! IMOVE_CREATE_DB_USER=true but IMOVE_DB_PASSWORD is empty. Skipped DB user creation.');
  } else {
    try {
      const existingUser = appDb.getUser(DB_USER);
      if (!existingUser) {
        appDb.createUser({
          user: DB_USER,
          pwd: DB_PASSWORD,
          roles: [{ role: 'readWrite', db: DB_NAME }],
        });
        print(`+ created MongoDB application user: ${DB_USER}`);
      } else {
        print(`= MongoDB application user already exists: ${DB_USER}`);
      }
    } catch (e) {
      print(`! Could not create MongoDB user. Current MongoDB account may lack userAdmin rights: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------------
print('');
print('==================== SETUP COMPLETE ========================');
print(`Database: ${DB_NAME}`);
print(`Collections: ${appDb.getCollectionNames().length}`);
print(`Services: ${appDb.services.countDocuments({})}`);
print(`Fare configs: ${appDb.fare_configs.countDocuments({})}`);
print(`Platform fees: ${appDb.platform_fees.countDocuments({})}`);
print(`Admin roles: ${appDb.admin_roles.countDocuments({})}`);
print(`Admin users: ${appDb.admin_users.countDocuments({})}`);
print(`Users: ${appDb.users.countDocuments({})}`);
print(`Drivers: ${appDb.drivers.countDocuments({})}`);
print('');
print('Bootstrap Admin (LOCAL/DEMO ONLY):');
print('  email: admin@th79.vn');
print('  username: admin');
print('  password: Admin@123456');
print('  mustChangePassword: true');
print('');
if (SEED_DEMO) {
  print('Demo customer: 0335555066 / 123456');
  print('Demo driver  : 0909000001 / 123456');
}
print('============================================================');
