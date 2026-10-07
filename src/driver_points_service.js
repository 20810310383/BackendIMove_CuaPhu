const crypto = require('crypto');
const { ObjectId } = require('mongodb');

function oid(value) {
  try { return value instanceof ObjectId ? value : new ObjectId(String(value)); }
  catch (_) { return null; }
}
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function clean(value, max = 160) {
  return String(value ?? '').trim().slice(0, max);
}
function pointValueVnd() {
  return Math.max(1, Math.trunc(num(process.env.DRIVER_POINT_VND_VALUE, 1000)));
}
function minimumTopupVnd() {
  return Math.max(pointValueVnd(), Math.trunc(num(process.env.DRIVER_POINT_TOPUP_MIN_VND, 50000)));
}
function companyBankInfo() {
  return {
    bankName: clean(process.env.COMPANY_BANK_NAME, 120),
    accountNumber: clean(process.env.COMPANY_BANK_ACCOUNT, 80),
    accountName: clean(process.env.COMPANY_BANK_ACCOUNT_NAME, 160),
    branch: clean(process.env.COMPANY_BANK_BRANCH, 160),
  };
}
function normalizePhone(value) {
  return String(value ?? '').replace(/\D/g, '').slice(-15);
}
function bankSafeText(value, max = 120) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function normalizeTransferContent(value) {
  return bankSafeText(value, 180).replace(/\s+/g, ' ').trim();
}
function nameInitials(value) {
  const words = bankSafeText(value, 64).split(' ').filter(Boolean);
  const initials = words.map((word) => word[0]).join('').slice(0, 4);
  return initials || 'TX';
}
function platformFeeVnd(booking) {
  return Math.max(0, Math.round(num(
    booking?.fareSnapshot?.platformCommission ??
    booking?.pricing?.platformCommission ??
    booking?.fareSnapshot?.platformRevenueEstimate ??
    booking?.pricing?.platformRevenueEstimate,
  )));
}
function platformFeePoints(booking) {
  const fee = platformFeeVnd(booking);
  return fee > 0 ? Math.ceil(fee / pointValueVnd()) : 0;
}

async function ensureDriverPointIndexes(db) {
  await Promise.allSettled([
    db.collection('driver_reward_accounts').createIndex({ driverId: 1 }, { unique: true, name: 'uq_driver_reward_account' }),
    db.collection('driver_reward_transactions').createIndex({ sourceTransactionId: 1 }, { unique: true, sparse: true, name: 'uq_driver_reward_source_tx' }),
    db.collection('driver_reward_transactions').createIndex({ driverId: 1, createdAt: -1 }, { name: 'idx_driver_reward_history' }),
    db.collection('driver_reward_transactions').createIndex({ type: 1, createdAt: -1 }, { name: 'idx_driver_reward_type_history' }),
    db.collection('driver_point_topups').createIndex({ driverId: 1, createdAt: -1 }, { name: 'idx_driver_point_topup_history' }),
    db.collection('driver_point_topups').createIndex({ status: 1, createdAt: -1 }, { name: 'idx_driver_point_topup_status' }),
    db.collection('driver_point_topups').createIndex({ transferCode: 1 }, { unique: true, name: 'uq_driver_point_topup_transfer_code' }),
    db.collection('driver_point_topups').createIndex({ bankTransactionId: 1 }, { unique: true, sparse: true, name: 'uq_driver_point_topup_bank_tx' }),
    db.collection('driver_point_topups').createIndex({ transferContentNormalized: 1 }, { name: 'idx_driver_point_topup_transfer_content' }),
  ]);
}

async function recomputeDriverPointAccount(db, { driverId, userId = null }) {
  const did = oid(driverId);
  if (!did) throw new Error('Driver id không hợp lệ.');
  const rows = await db.collection('driver_reward_transactions').aggregate([
    { $match: { driverId: did } },
    { $group: {
      _id: null,
      balance: { $sum: '$points' },
      lifetimeEarned: { $sum: { $cond: [{ $gt: ['$points', 0] }, '$points', 0] } },
      lifetimeSpent: { $sum: { $cond: [{ $lt: ['$points', 0] }, { $abs: '$points' }, 0] } },
    } },
  ]).toArray();
  const summary = rows[0] || { balance: 0, lifetimeEarned: 0, lifetimeSpent: 0 };
  const now = new Date();
  await db.collection('driver_reward_accounts').updateOne(
    { driverId: did },
    {
      $set: {
        ...(userId ? { userId: oid(userId) || userId } : {}),
        balance: Math.trunc(num(summary.balance)),
        lifetimeEarned: Math.trunc(num(summary.lifetimeEarned)),
        lifetimeSpent: Math.trunc(num(summary.lifetimeSpent)),
        pointValueVnd: pointValueVnd(),
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  return db.collection('driver_reward_accounts').findOne({ driverId: did });
}

async function recordPlatformFeeDebit(db, { booking, driverId, userId }) {
  const did = oid(driverId || booking?.driverId);
  const uid = oid(userId);
  if (!did) return { status: 'SKIPPED', reason: 'NO_DRIVER' };
  const bookingId = oid(booking?._id || booking?.id);
  if (!bookingId) return { status: 'SKIPPED', reason: 'NO_BOOKING' };
  const points = platformFeePoints(booking);
  if (points <= 0) return { status: 'SKIPPED', reason: 'NO_PLATFORM_FEE' };
  const feeVnd = platformFeeVnd(booking);
  const sourceTransactionId = `PLATFORM_FEE:${String(bookingId)}`;
  const now = booking?.completedAt ? new Date(booking.completedAt) : new Date();
  const result = await db.collection('driver_reward_transactions').updateOne(
    { sourceTransactionId },
    {
      $setOnInsert: {
        driverId: did,
        ...(uid ? { userId: uid } : {}),
        bookingId,
        sourceTransactionId,
        type: 'PLATFORM_FEE',
        points: -points,
        amountVnd: feeVnd,
        title: `Phí nền tảng chuyến ${booking?.bookingCode || ''}`.trim(),
        createdAt: now,
      },
    },
    { upsert: true },
  );
  return { status: result.upsertedCount ? 'DEBITED' : 'EXISTING', points, feeVnd };
}

async function syncDriverPointAccount(db, ctx) {
  await ensureDriverPointIndexes(db);
  const bookings = await db.collection('bookings')
    .find({ driverId: ctx.driver._id, status: 'COMPLETED' })
    .project({ _id: 1, bookingCode: 1, completedAt: 1, createdAt: 1, pricing: 1, fareSnapshot: 1, driverId: 1 })
    .sort({ completedAt: 1, createdAt: 1 })
    .limit(5000)
    .toArray();
  for (const booking of bookings) {
    await recordPlatformFeeDebit(db, { booking, driverId: ctx.driver._id, userId: ctx.user._id });
  }
  return recomputeDriverPointAccount(db, { driverId: ctx.driver._id, userId: ctx.user._id });
}

function transferCodeFor(driverId, phone = '', driverName = '') {
  const nameCode = nameInitials(driverName);
  const phoneTail = normalizePhone(phone).slice(-6) || String(driverId).slice(-6).toUpperCase();
  const date = new Date();
  const stamp = `${String(date.getFullYear()).slice(-2)}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `IMV-${nameCode}-${phoneTail}-${stamp}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function transferContentFor({ driverName, driverPhone, transferCode }) {
  const name = bankSafeText(driverName || 'TAI XE', 48);
  const phone = normalizePhone(driverPhone);
  const code = bankSafeText(transferCode, 36);
  return normalizeTransferContent(`NAP DIEM ${name} ${phone} ${code}`);
}

async function resolveDriverSnapshot(db, { driverId, userId, driverName = '', driverPhone = '' }) {
  const did = oid(driverId);
  const uid = oid(userId);
  let name = clean(driverName, 160);
  let phone = clean(driverPhone, 40);
  if ((!name || !phone) && uid) {
    const user = await db.collection('users').findOne({ _id: uid }, { projection: { fullName: 1, phone: 1 } });
    name ||= clean(user?.fullName, 160);
    phone ||= clean(user?.phone, 40);
  }
  if ((!name || !phone) && did) {
    const driver = await db.collection('drivers').findOne({ _id: did }, { projection: { fullName: 1, phone: 1 } });
    name ||= clean(driver?.fullName, 160);
    phone ||= clean(driver?.phone, 40);
  }
  return {
    fullName: name || 'Tài xế',
    phone: phone || '',
  };
}

async function createTopupRequest(db, { driverId, userId, amountVnd, driverName = '', driverPhone = '' }) {
  await ensureDriverPointIndexes(db);
  const did = oid(driverId);
  const uid = oid(userId);
  if (!did || !uid) throw new Error('Tài xế không hợp lệ.');
  const bankInfo = companyBankInfo();
  if (!bankInfo.bankName || !bankInfo.accountNumber || !bankInfo.accountName) {
    throw new Error('Tài khoản ngân hàng công ty chưa được cấu hình đầy đủ.');
  }
  const amount = Math.trunc(num(amountVnd));
  if (amount < minimumTopupVnd()) {
    throw new Error(`Số tiền nạp tối thiểu ${minimumTopupVnd().toLocaleString('vi-VN')}đ.`);
  }
  const points = Math.floor(amount / pointValueVnd());
  if (points <= 0) throw new Error('Số điểm quy đổi không hợp lệ.');
  const driverSnapshot = await resolveDriverSnapshot(db, {
    driverId: did,
    userId: uid,
    driverName,
    driverPhone,
  });
  const now = new Date();
  let transferCode = transferCodeFor(did, driverSnapshot.phone, driverSnapshot.fullName);
  for (let i = 0; i < 8; i += 1) {
    const exists = await db.collection('driver_point_topups').findOne({ transferCode });
    if (!exists) break;
    transferCode = transferCodeFor(did, driverSnapshot.phone, driverSnapshot.fullName);
  }
  const transferContent = transferContentFor({
    driverName: driverSnapshot.fullName,
    driverPhone: driverSnapshot.phone,
    transferCode,
  });
  const doc = {
    driverId: did,
    userId: uid,
    driverSnapshot,
    fundType: 'DRIVER_POINTS',
    paymentMethod: 'BANK_TRANSFER',
    amountVnd: amount,
    points,
    pointValueVnd: pointValueVnd(),
    transferCode,
    transferContent,
    transferContentNormalized: normalizeTransferContent(transferContent),
    bankInfo,
    status: 'PENDING_REVIEW',
    note: 'Chờ đối chiếu giao dịch chuyển khoản vào tài khoản công ty.',
    createdAt: now,
    updatedAt: now,
  };
  const r = await db.collection('driver_point_topups').insertOne(doc);
  return { ...doc, _id: r.insertedId };
}

async function approveTopupRequest(db, {
  topupId,
  adminId = null,
  confirmedVia = 'ADMIN',
  bankTransactionId = null,
  bankTransferContent = null,
  bankOccurredAt = null,
}) {
  const id = oid(topupId);
  if (!id) throw new Error('Yêu cầu nạp điểm không hợp lệ.');
  const topup = await db.collection('driver_point_topups').findOne({ _id: id });
  if (!topup) throw new Error('Không tìm thấy yêu cầu nạp điểm.');
  if (topup.status === 'APPROVED') return topup;
  if (topup.status === 'REJECTED') throw new Error('Yêu cầu đã bị từ chối.');
  const sourceTransactionId = `BANK_TOPUP:${String(id)}`;
  await db.collection('driver_reward_transactions').updateOne(
    { sourceTransactionId },
    { $setOnInsert: {
      driverId: topup.driverId,
      userId: topup.userId,
      sourceTransactionId,
      topupId: id,
      type: 'BANK_TOPUP',
      points: Math.trunc(num(topup.points)),
      amountVnd: Math.trunc(num(topup.amountVnd)),
      title: `Nạp điểm chuyển khoản ${topup.transferCode}`,
      transferCode: topup.transferCode,
      transferContent: topup.transferContent || topup.transferCode,
      createdAt: new Date(),
    } },
    { upsert: true },
  );
  const now = new Date();
  const bankTx = clean(bankTransactionId, 120) || null;
  await db.collection('driver_point_topups').updateOne(
    { _id: id },
    { $set: {
      status: 'APPROVED',
      approvedBy: oid(adminId) || adminId || null,
      approvedAt: now,
      confirmedVia: clean(confirmedVia, 40) || 'ADMIN',
      ...(bankTx ? { bankTransactionId: bankTx } : {}),
      ...(bankTransferContent ? { bankTransferContent: clean(bankTransferContent, 300) } : {}),
      ...(bankOccurredAt ? { bankOccurredAt: (() => { const d = new Date(bankOccurredAt); return Number.isNaN(d.getTime()) ? now : d; })() } : {}),
      updatedAt: now,
    } },
  );
  await recomputeDriverPointAccount(db, { driverId: topup.driverId, userId: topup.userId });
  return db.collection('driver_point_topups').findOne({ _id: id });
}

async function confirmTopupByBankTransfer(db, {
  bankTransactionId,
  amountVnd,
  transferContent,
  occurredAt = null,
}) {
  await ensureDriverPointIndexes(db);
  const bankTx = clean(bankTransactionId, 120);
  if (!bankTx) throw new Error('Thiếu bankTransactionId.');
  const amount = Math.trunc(num(amountVnd));
  if (amount <= 0) throw new Error('Số tiền giao dịch không hợp lệ.');
  const normalized = normalizeTransferContent(transferContent);
  if (!normalized) throw new Error('Thiếu nội dung chuyển khoản.');

  const existing = await db.collection('driver_point_topups').findOne({ bankTransactionId: bankTx });
  if (existing) {
    return { status: 'EXISTING', topup: existing };
  }

  const codeMatch = normalized.match(/IMV-[A-Z0-9-]+/);
  let topup = null;
  if (codeMatch?.[0]) {
    topup = await db.collection('driver_point_topups').findOne({ transferCode: codeMatch[0] });
  }
  if (!topup) {
    topup = await db.collection('driver_point_topups').findOne({
      transferContentNormalized: normalized,
      status: 'PENDING_REVIEW',
    });
  }
  if (!topup) throw new Error('Không tìm thấy yêu cầu nạp điểm phù hợp với nội dung chuyển khoản.');
  if (topup.status === 'REJECTED') throw new Error('Yêu cầu nạp điểm đã bị từ chối.');
  if (Math.trunc(num(topup.amountVnd)) !== amount) {
    await db.collection('driver_point_topups').updateOne(
      { _id: topup._id },
      { $set: {
        status: 'AMOUNT_MISMATCH',
        receivedAmountVnd: amount,
        bankTransactionId: bankTx,
        bankTransferContent: clean(transferContent, 300),
        bankOccurredAt: occurredAt ? new Date(occurredAt) : new Date(),
        updatedAt: new Date(),
      } },
    );
    throw new Error(`Số tiền nhận ${amount.toLocaleString('vi-VN')}đ không khớp yêu cầu ${Math.trunc(num(topup.amountVnd)).toLocaleString('vi-VN')}đ.`);
  }

  const approved = await approveTopupRequest(db, {
    topupId: topup._id,
    confirmedVia: 'BANK_WEBHOOK',
    bankTransactionId: bankTx,
    bankTransferContent: transferContent,
    bankOccurredAt: occurredAt || new Date(),
  });
  return { status: 'APPROVED', topup: approved };
}

async function rejectTopupRequest(db, { topupId, adminId = null, reason = '' }) {
  const id = oid(topupId);
  if (!id) throw new Error('Yêu cầu nạp điểm không hợp lệ.');
  const topup = await db.collection('driver_point_topups').findOne({ _id: id });
  if (!topup) throw new Error('Không tìm thấy yêu cầu nạp điểm.');
  if (topup.status === 'APPROVED') throw new Error('Yêu cầu đã được duyệt và cộng điểm.');
  const now = new Date();
  await db.collection('driver_point_topups').updateOne(
    { _id: id },
    { $set: { status: 'REJECTED', rejectedBy: oid(adminId) || adminId || null, rejectedAt: now, rejectReason: clean(reason, 500), updatedAt: now } },
  );
  return db.collection('driver_point_topups').findOne({ _id: id });
}


async function createAdminPointAdjustment(db, {
  driverId,
  points,
  reason,
  reference = '',
  adminId = null,
  idempotencyKey,
}) {
  await ensureDriverPointIndexes(db);
  const did = oid(driverId);
  const aid = oid(adminId);
  if (!did) throw new Error('Driver id không hợp lệ.');
  const delta = Math.trunc(num(points));
  if (!delta) throw new Error('Số điểm điều chỉnh phải khác 0.');
  if (Math.abs(delta) > 1000000) throw new Error('Số điểm điều chỉnh vượt giới hạn cho phép.');
  const why = clean(reason, 500);
  if (why.length < 3) throw new Error('Vui lòng nhập lý do điều chỉnh.');
  const idem = clean(idempotencyKey, 120);
  if (!idem) throw new Error('Thiếu Idempotency-Key cho giao dịch điều chỉnh.');

  const driver = await db.collection('drivers').findOne({ _id: did });
  if (!driver) throw new Error('Không tìm thấy tài xế.');
  const uid = oid(driver.userId);
  const user = uid ? await db.collection('users').findOne({ _id: uid }, { projection: { fullName: 1, phone: 1 } }) : null;
  const sourceTransactionId = `ADMIN_ADJUSTMENT:${idem}`;
  const existing = await db.collection('driver_reward_transactions').findOne({ sourceTransactionId });
  if (existing) {
    const account = await recomputeDriverPointAccount(db, { driverId: did, userId: uid });
    return { existing: true, transaction: existing, account, driver: { id: String(did), fullName: user?.fullName || driver.fullName || 'Tài xế', phone: user?.phone || driver.phone || '' } };
  }

  const now = new Date();
  const transaction = {
    driverId: did,
    ...(uid ? { userId: uid } : {}),
    sourceTransactionId,
    type: 'ADMIN_ADJUSTMENT',
    points: delta,
    amountVnd: Math.abs(delta) * pointValueVnd(),
    direction: delta > 0 ? 'CREDIT' : 'DEBIT',
    title: delta > 0 ? 'Admin cộng điểm tài xế' : 'Admin trừ điểm tài xế',
    reason: why,
    reference: clean(reference, 160) || null,
    adminId: aid || adminId || null,
    createdAt: now,
  };
  await db.collection('driver_reward_transactions').insertOne(transaction);
  const account = await recomputeDriverPointAccount(db, { driverId: did, userId: uid });
  return { existing: false, transaction, account, driver: { id: String(did), fullName: user?.fullName || driver.fullName || 'Tài xế', phone: user?.phone || driver.phone || '' } };
}

async function listAdminDriverPointAccounts(db, { keyword = '', limit = 300 } = {}) {
  await ensureDriverPointIndexes(db);
  const drivers = await db.collection('drivers')
    .find({ approvalStatus: 'APPROVED' })
    .project({ userId: 1, fullName: 1, phone: 1, rating: 1, onlineStatus: 1 })
    .sort({ updatedAt: -1 })
    .limit(Math.max(1, Math.min(1000, Math.trunc(num(limit, 300)))))
    .toArray();
  const userIds = drivers.map((x) => oid(x.userId)).filter(Boolean);
  const driverIds = drivers.map((x) => x._id);
  const [users, accounts] = await Promise.all([
    userIds.length ? db.collection('users').find({ _id: { $in: userIds } }).project({ fullName: 1, phone: 1 }).toArray() : [],
    driverIds.length ? db.collection('driver_reward_accounts').find({ driverId: { $in: driverIds } }).toArray() : [],
  ]);
  const byUser = new Map(users.map((x) => [String(x._id), x]));
  const byDriver = new Map(accounts.map((x) => [String(x.driverId), x]));
  const q = clean(keyword, 120).toLowerCase();
  return drivers.map((driver) => {
    const user = byUser.get(String(driver.userId));
    const account = byDriver.get(String(driver._id));
    return {
      driverId: String(driver._id),
      userId: driver.userId ? String(driver.userId) : null,
      fullName: user?.fullName || driver.fullName || 'Tài xế',
      phone: user?.phone || driver.phone || '',
      rating: num(driver.rating, 0),
      onlineStatus: driver.onlineStatus || 'OFFLINE',
      balance: Math.trunc(num(account?.balance, 0)),
      lifetimeEarned: Math.trunc(num(account?.lifetimeEarned, 0)),
      lifetimeSpent: Math.trunc(num(account?.lifetimeSpent, 0)),
      pointValueVnd: pointValueVnd(),
    };
  }).filter((row) => !q || `${row.fullName} ${row.phone} ${row.driverId}`.toLowerCase().includes(q));
}

function serializePointAdjustment(row) {
  return {
    id: String(row._id || row.sourceTransactionId || ''),
    driverId: row.driverId ? String(row.driverId) : null,
    userId: row.userId ? String(row.userId) : null,
    sourceTransactionId: row.sourceTransactionId || null,
    type: row.type || 'ADMIN_ADJUSTMENT',
    points: Math.trunc(num(row.points)),
    amountVnd: Math.trunc(num(row.amountVnd)),
    direction: row.direction || (num(row.points) >= 0 ? 'CREDIT' : 'DEBIT'),
    title: row.title || '',
    reason: row.reason || '',
    reference: row.reference || null,
    adminId: row.adminId ? String(row.adminId) : null,
    createdAt: row.createdAt || null,
  };
}

function serializeTopup(row) {
  return {
    id: String(row._id),
    driverId: String(row.driverId),
    userId: String(row.userId),
    driver: row.driverSnapshot ? {
      fullName: row.driverSnapshot.fullName || '',
      phone: row.driverSnapshot.phone || '',
    } : null,
    fundType: row.fundType || 'DRIVER_POINTS',
    paymentMethod: row.paymentMethod || 'BANK_TRANSFER',
    amountVnd: Math.trunc(num(row.amountVnd)),
    points: Math.trunc(num(row.points)),
    pointValueVnd: Math.trunc(num(row.pointValueVnd, pointValueVnd())),
    transferCode: row.transferCode,
    transferContent: row.transferContent || row.transferCode || '',
    bankInfo: row.bankInfo || companyBankInfo(),
    status: row.status,
    note: row.note || '',
    rejectReason: row.rejectReason || '',
    confirmedVia: row.confirmedVia || null,
    bankTransactionId: row.bankTransactionId || null,
    receivedAmountVnd: row.receivedAmountVnd == null ? null : Math.trunc(num(row.receivedAmountVnd)),
    createdAt: row.createdAt,
    approvedAt: row.approvedAt || null,
    rejectedAt: row.rejectedAt || null,
  };
}

module.exports = {
  pointValueVnd,
  minimumTopupVnd,
  companyBankInfo,
  platformFeeVnd,
  platformFeePoints,
  ensureDriverPointIndexes,
  recomputeDriverPointAccount,
  recordPlatformFeeDebit,
  syncDriverPointAccount,
  createTopupRequest,
  approveTopupRequest,
  confirmTopupByBankTransfer,
  rejectTopupRequest,
  createAdminPointAdjustment,
  listAdminDriverPointAccounts,
  serializePointAdjustment,
  serializeTopup,
  normalizeTransferContent,
  transferContentFor,
};
