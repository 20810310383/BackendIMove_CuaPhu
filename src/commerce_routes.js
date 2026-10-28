const express = require('express');
const { ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { createAuthenticate } = require('./auth_routes');
const { createAdminGuard } = require('./admin_guard');
const { verifiedMetrics } = require('./trusted_route_pricing');
const { DOCUMENT_TYPES, reviewStatus, missingReviewItems, reviewSummary } = require('./merchant_review_policy');
const {storageRoot} = require('./local_storage_service');
const { driverServicePreferenceEnabled } = require('./service_catalog_service');

const ORDER_STATUSES = [
  'CREATED','WAITING_MERCHANT','MERCHANT_ACCEPTED','PREPARING','READY_FOR_PICKUP',
  'DRIVER_ASSIGNED','DRIVER_AT_MERCHANT','PICKED_UP','DELIVERING','DELIVERED','COMPLETED','CANCELLED'
];
const COMMERCE_SERVICE_CODES = ['FOOD','ERRAND','DELIVERY'];
// Keep the operations feed small and page it on the server so a slow MongoDB
// connection does not need to read every commerce order for one screen.
const ADMIN_COMMERCE_ORDERS_LIMIT = 20;
const ADMIN_COMMERCE_ORDERS_MAX_LIMIT = 200;
const MERCHANT_TRANSITIONS = {
  WAITING_MERCHANT: ['MERCHANT_ACCEPTED','CANCELLED'],
  MERCHANT_ACCEPTED: ['PREPARING','READY_FOR_PICKUP','CANCELLED'],
  PREPARING: ['READY_FOR_PICKUP','CANCELLED'],
  READY_FOR_PICKUP: ['DRIVER_ASSIGNED','DRIVER_AT_MERCHANT','PICKED_UP'],
  DRIVER_ASSIGNED: ['DRIVER_AT_MERCHANT','PICKED_UP'],
  DRIVER_AT_MERCHANT: ['PICKED_UP'],
};

const DEFAULT_DELIVERY_POLICY = {
  standard: { mode:'FIXED', value:0 },
  priority: { mode:'PERCENT', value:20 },
  fragile: { mode:'FIXED', value:10000 },
  cod: { enabled:false, requireKyc:true },
};
let driverPointPolicyCache = { value: null, expiresAt: 0 };
function normalizeFeeRule(value, fallback){
  const mode=String(value?.mode||fallback.mode||'FIXED').toUpperCase();
  return {mode:['FIXED','PERCENT'].includes(mode)?mode:'FIXED',value:Math.max(0,Number(value?.value??fallback.value??0)||0)};
}
function feeFromRule(base, rule){return rule.mode==='PERCENT'?Math.round(base*Number(rule.value||0)/100):Math.round(Number(rule.value||0));}
function normalizePreference(value){const s=String(value||'STANDARD').trim().toUpperCase();return ['PRIORITY','ƯU TIÊN','UU TIEN'].includes(s)?'PRIORITY':'STANDARD';}
function customerKycApproved(user){return ['APPROVED','VERIFIED','PASSED'].includes(String(user?.customerKycStatus||user?.kycStatus||user?.identityStatus||'').toUpperCase());}
async function getDriverPointPolicy(db){
  if (driverPointPolicyCache.value && driverPointPolicyCache.expiresAt > Date.now()) {
    return driverPointPolicyCache.value;
  }
  const policy=await db.collection('matching_policies').findOne({status:'ACTIVE'},{sort:{version:-1}}).catch(()=>null);
  const value = {
    blockBelow:Number(policy?.pointsPolicy?.blockBelow ?? 0),
    warnBelow:Number(policy?.pointsPolicy?.warnBelow ?? 20),
  };
  // Point policy rarely changes. A brief cache keeps the dispatch picker
  // responsive without materially delaying an admin policy update.
  driverPointPolicyCache = { value, expiresAt: Date.now() + 10_000 };
  return value;
}
async function getDriverPointBalance(db,driverId){
  const account=await db.collection('driver_reward_accounts').findOne({driverId});
  return Number(account?.balance ?? 0);
}
async function assertDriverPointsEligible(db,driverId){
  const [pointPolicy,pointBalance]=await Promise.all([getDriverPointPolicy(db),getDriverPointBalance(db,driverId)]);
  if(pointBalance<pointPolicy.blockBelow){
    const error=new Error(`Tài xế đang âm điểm (${pointBalance}). Cần nạp điểm trước khi nhận đơn.`);
    error.code='DRIVER_POINTS_BLOCKED';
    throw error;
  }
  return {pointBalance,pointsLow:pointBalance<=pointPolicy.warnBelow,pointPolicy};
}
async function getDeliveryPolicy(db){
  const raw=await db.collection('commerce_settings').findOne({_id:'DELIVERY_FEE_POLICY'}).catch(()=>null);
  return {
    standard:normalizeFeeRule(raw?.standard,DEFAULT_DELIVERY_POLICY.standard),
    priority:normalizeFeeRule(raw?.priority,DEFAULT_DELIVERY_POLICY.priority),
    fragile:normalizeFeeRule(raw?.fragile,DEFAULT_DELIVERY_POLICY.fragile),
    cod:{enabled:Boolean(raw?.cod?.enabled),requireKyc:raw?.cod?.requireKyc!==false},
  };
}
async function priceDeliveryExtras({db,baseFee,details,user}){
  const policy=await getDeliveryPolicy(db);
  const input=details&&typeof details==='object'?details:{};
  const preference=normalizePreference(input.deliveryPreference);
  const fragile=Boolean(input.fragile);
  const codAmount=Number(input.codAmount||0);
  if(!Number.isSafeInteger(codAmount)||codAmount<0||codAmount>1000000000)throw Object.assign(new Error('Số tiền thu hộ COD không hợp lệ.'),{code:'INVALID_COD_AMOUNT'});
  if(codAmount>0){
    if(!policy.cod.enabled) { const e=new Error('Thu hộ COD đang tắt trên hệ thống.');e.code='COD_DISABLED';throw e; }
    if(policy.cod.requireKyc&&!customerKycApproved(user)){const e=new Error('Thu hộ COD chỉ dành cho khách hàng đã KYC. Vui lòng hoàn tất KYC trước khi bật COD.');e.code='CUSTOMER_KYC_REQUIRED_FOR_COD';throw e;}
  }
  const preferenceRule=preference==='PRIORITY'?policy.priority:policy.standard;
  const preferenceSurcharge=feeFromRule(baseFee,preferenceRule);
  const fragileSurcharge=fragile?feeFromRule(baseFee,policy.fragile):0;
  return {policy,preference,fragile,codAmount,preferenceSurcharge,fragileSurcharge,totalSurcharge:preferenceSurcharge+fragileSurcharge,total:Math.max(0,Math.round(baseFee+preferenceSurcharge+fragileSurcharge))};
}

function oid(value) {
  try { return new ObjectId(String(value)); } catch (_) { return null; }
}

async function ensureCommerceIndexes(db) {
  await Promise.all([
    db.collection('orders').createIndex(
      { serviceCode: 1, createdAt: -1 },
      { name: 'idx_commerce_orders_recent' },
    ),
    db.collection('orders').createIndex(
      { serviceCode: 1, status: 1, createdAt: -1 },
      { name: 'idx_commerce_orders_service_status_recent' },
    ),
    // Manual dispatch opens the newest registered driver accounts first.
    // This avoids an in-memory sort of the full drivers collection.
    db.collection('drivers').createIndex(
      { createdAt: -1, _id: -1 },
      { name: 'idx_commerce_driver_roster_recent' },
    ),
  ]).catch((error) => {
    console.warn('[COMMERCE INDEX]', error.message);
  });
}
function adminMerchantRecord(merchant) {
  const record=serialize(merchant);
  delete record.reviewDocuments;
  return {...record,...reviewSummary(merchant)};
}
function publicMerchantRecord(merchant) {
  const record=serialize(merchant);
  for (const key of ['reviewDocuments','reviewReason','reviewedBy','reviewedAt','approvalStatus','submittedAt']) delete record[key];
  return record;
}
function serialize(value) {
  if (!value) return value;
  const out = { ...value };
  if (out._id) out._id = String(out._id);
  for (const key of ['merchantId','customerId','driverId','orderId','userId']) {
    if (out[key]) out[key] = String(out[key]);
  }
  return out;
}

const MERCHANT_MEDIA_ROOT = path.resolve(
  __dirname,
  '..',
  String(process.env.LOCAL_UPLOAD_ROOT || 'storage').trim() || 'storage',
  'merchant',
);

// Sensitive verification files are never mounted by the public merchant-media route.
const MERCHANT_REVIEW_ROOT = path.join(storageRoot, 'private', 'merchant_review');
const merchantReviewUpload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const folder=path.join(MERCHANT_REVIEW_ROOT,String(req.merchantContext.merchant._id));
      fs.mkdirSync(folder,{recursive:true,mode:0o700});cb(null,folder);
    },
    filename(_req,_file,cb) {cb(null,crypto.randomBytes(20).toString('hex')+'.img');},
  }),
  limits:{fileSize:5*1024*1024,files:1},
  fileFilter(_req,file,cb) {
    cb(null,['image/jpeg','image/png','image/webp'].includes(String(file.mimetype||'').toLowerCase()));
  },
});
function verifiedReviewMime(buffer) {
  if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return 'image/jpeg';
  if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
  if(buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return null;
}
function sendReviewDocument(res,merchant,kind) {
  const doc=merchant?.reviewDocuments?.[kind];
  const filename=String(doc?.filename||'');
  if(!/^[a-f0-9]{40}\.img$/.test(filename))return res.status(404).json({message:'Chưa có giấy tờ.'});
  const filepath=path.join(MERCHANT_REVIEW_ROOT,String(merchant._id),filename);
  if(!fs.existsSync(filepath))return res.status(404).json({message:'Không tìm thấy tệp hồ sơ.'});
  res.setHeader('Content-Type',doc.mime||'application/octet-stream');
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Disposition','inline; filename="ho-so-'+kind.toLowerCase()+'.img"');
  return res.sendFile(filepath);
}

function merchantMediaExtension(file) {
  const mime = String(file?.mimetype || '').toLowerCase();
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

const merchantMediaUpload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const merchantId = String(req.merchantContext?.merchant?._id || 'unknown');
      const dir = path.join(MERCHANT_MEDIA_ROOT, merchantId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const kind = String(req.params.kind || 'image').toLowerCase();
      const safeKind = ['logo', 'cover'].includes(kind) ? kind : 'image';
      cb(null, `${safeKind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${merchantMediaExtension(file)}`);
    },
  }),
  limits: {
    fileSize: Math.max(1, Number(process.env.MERCHANT_MEDIA_MAX_FILE_MB || 8)) * 1024 * 1024,
  },
  fileFilter(_req, file, cb) {
    const allowed = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
    if (!allowed.has(String(file?.mimetype || '').toLowerCase())) {
      return cb(new Error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WEBP.'));
    }
    cb(null, true);
  },
});

function merchantMediaPublicPath(merchantId, filename) {
  return `/api/v16/commerce/merchant-media/${encodeURIComponent(String(merchantId))}/${encodeURIComponent(path.basename(filename))}`;
}

function deleteOldMerchantMedia(urlValue, merchantId) {
  const value = String(urlValue || '');
  const prefix = `/api/v16/commerce/merchant-media/${String(merchantId)}/`;
  if (!value.includes(prefix)) return;
  const name = decodeURIComponent(value.split(prefix).pop() || '');
  if (!name || name !== path.basename(name)) return;
  fs.promises.unlink(path.join(MERCHANT_MEDIA_ROOT, String(merchantId), name)).catch(() => {});
}

function orderCode() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  return `IMF-${stamp}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}
async function merchantContext(db, userId) {
  const membership = await db.collection('merchant_users').findOne({ userId });
  if (!membership) return null;
  const merchant = await db.collection('merchants').findOne({ _id: membership.merchantId });
  if (!merchant) return null;
  return { membership, merchant };
}
function createRequireMerchant(getDb) {
  const authenticate = createAuthenticate(getDb);
  return [authenticate, async (req,res,next) => {
    const roles = Array.isArray(req.auth?.user?.roles) ? req.auth.user.roles : [];
    if (!roles.includes('MERCHANT')) return res.status(403).json({ message:'Tài khoản không có quyền MERCHANT.' });
    const context = await merchantContext(getDb(), req.auth.user._id);
    if (!context) return res.status(403).json({ message:'Tài khoản chưa được gán vào cửa hàng.' });
    if (String(context.merchant.status||'ACTIVE').toUpperCase() === 'SUSPENDED') return res.status(403).json({ message:'Cửa hàng đang bị tạm khóa.' });
    req.merchantContext = context;
    next();
  }];
}


function normalizeCaps(driver) {
  const approved = Array.isArray(driver?.approvedServiceCodes)
    ? driver.approvedServiceCodes.map((x) => String(x || '').toUpperCase()).filter(Boolean)
    : [];
  if (approved.length) return approved;
  return Array.isArray(driver?.serviceCapabilities)
    ? driver.serviceCapabilities.map((x) => String(x || '').toUpperCase()).filter(Boolean)
    : [];
}

function driverCanHandleCommerce(driver, serviceCode) {
  const code = String(serviceCode || '').toUpperCase();
  const approved = Array.isArray(driver?.approvedServiceCodes)
    ? driver.approvedServiceCodes.map((x) => String(x || '').toUpperCase()).filter(Boolean)
    : [];
  // Driver mới: approvedServiceCodes là nguồn quyền chính thức và preference phải bật.
  if (approved.length) {
    if (!approved.includes(code)) return false;
    if (!driverServicePreferenceEnabled(driver, code)) return false;
    return true;
  }
  // Driver legacy: giữ tương thích serviceCapabilities cho tới khi Admin migrate hồ sơ.
  const caps = normalizeCaps(driver);
  if (!caps.length) return true;
  if (!driverServicePreferenceEnabled(driver, code)) return false;
  if (caps.includes(code)) return true;
  if (['FOOD','ERRAND','DELIVERY'].includes(code) && caps.includes('BIKE')) return true;
  if (['FOOD','ERRAND'].includes(code) && caps.includes('DELIVERY')) return true;
  return false;
}

function commerceDispatchBlockReason(driver, serviceCode) {
  if (String(driver?.approvalStatus || '').toUpperCase() !== 'APPROVED') {
    return 'Tài khoản chưa được duyệt.';
  }
  if (String(driver?.kycStatus || '').toUpperCase() !== 'APPROVED') {
    return 'Hồ sơ KYC chưa được duyệt.';
  }
  if (!driverCanHandleCommerce(driver, serviceCode)) {
    return 'Chưa bật dịch vụ phù hợp với đơn này.';
  }
  if (driver?.activeBookingId || driver?.activeCommerceOrderId) {
    return 'Tài xế đang có đơn.';
  }
  if (String(driver?.onlineStatus || '').toUpperCase() !== 'ONLINE') {
    return 'Tài xế chưa ONLINE.';
  }
  if (driver?.pointStatus === 'BLOCKED') {
    return driver.pointWarning || 'Tài xế đang bị chặn do số dư điểm.';
  }
  return null;
}

function escapeSearchRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function decorateCommerceDrivers(db, drivers, serviceCode) {
  const safeDrivers = Array.isArray(drivers) ? drivers : [];
  if (!safeDrivers.length) return [];
  const driverIds = safeDrivers.map((d) => d._id).filter(Boolean);
  const userIds = safeDrivers.map((d) => d.userId).filter(Boolean);
  const [users, accounts, pointPolicy] = await Promise.all([
    userIds.length
      ? db.collection('users').find({ _id: { $in: userIds } }).project({ fullName:1, phone:1 }).toArray()
      : [],
    driverIds.length
      ? db.collection('driver_reward_accounts').find({ driverId: { $in: driverIds } }).project({driverId:1,balance:1}).toArray()
      : [],
    getDriverPointPolicy(db),
  ]);
  const byUserId = new Map(users.map((u) => [String(u._id), u]));
  const byDriverId = new Map(accounts.map((a) => [String(a.driverId), Number(a.balance || 0)]));

  return safeDrivers.map((d) => {
    const u = byUserId.get(String(d.userId)) || {};
    const pointBalance=Number(byDriverId.get(String(d._id)) ?? 0);
    const pointStatus = pointBalance < pointPolicy.blockBelow ? 'BLOCKED' : (pointBalance <= pointPolicy.warnBelow ? 'LOW' : 'OK');
    const pointWarning = pointBalance < pointPolicy.blockBelow
      ? `Số dư điểm ${pointBalance}. Tài xế cần nạp điểm trước khi nhận đơn.`
      : (pointBalance <= pointPolicy.warnBelow ? `Số dư điểm còn ${pointBalance}. Nên nạp thêm điểm.` : null);
    const decorated = {
      ...d,
      fullName: d.fullName || d.name || u.fullName || 'Tài xế',
      phone: d.phone || u.phone || '',
      pointBalance,
      pointStatus,
      pointWarning,
    };
    return {
      ...decorated,
      dispatchBlockReason: commerceDispatchBlockReason(decorated, serviceCode),
    };
  });
}

async function eligibleCommerceDrivers(db, serviceCode, { onlineOnly = true } = {}) {
  const query = {
    approvalStatus: 'APPROVED',
    kycStatus: 'APPROVED',
    $and: [
      { $or: [{ activeBookingId: null }, { activeBookingId: { $exists: false } }] },
      { $or: [{ activeCommerceOrderId: null }, { activeCommerceOrderId: { $exists: false } }] },
    ],
  };
  if (onlineOnly) query.onlineStatus = 'ONLINE';

  const drivers = await db.collection('drivers').find(query).limit(500).toArray();
  const capable = drivers.filter((d) => driverCanHandleCommerce(d, serviceCode));
  return (await decorateCommerceDrivers(db, capable, serviceCode))
    .filter((d) => !d.dispatchBlockReason);
}

// The manual dispatch picker must be able to find a driver as soon as they
// register in the Driver app.  Eligibility remains enforced separately when
// assigning the order; unavailable drivers are returned with a clear reason
// instead of being silently omitted like they were before.
async function getCommerceDispatchRoster(db, serviceCode, { search = '', limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const keyword = String(search || '').trim().slice(0, 80);
  let query;
  let sort = null;

  if (keyword) {
    const escapedKeyword = escapeSearchRegex(keyword);
    const isPhone = /^\d{3,15}$/.test(keyword);
    const namePattern = new RegExp(`^${escapedKeyword}`, 'i');
    const phonePattern = isPhone ? keyword : new RegExp(`^${escapedKeyword}`, 'i');
    const matchedUsers = await db.collection('users').find(
      { $or: [{ fullName: namePattern }, { phone: phonePattern }] },
      { projection: { _id: 1 } },
    ).limit(safeLimit).toArray();
    const terms = [
      { fullName: namePattern },
      { name: namePattern },
      { phone: phonePattern },
    ];
    const userIds = matchedUsers.map((user) => user._id).filter(Boolean);
    if (userIds.length) terms.push({ userId: { $in: userIds } });
    const exactDriverId = oid(keyword);
    if (exactDriverId) terms.push({ _id: exactDriverId });
    query = { $or: terms };
    sort = { createdAt: -1, _id: -1 };
  } else {
    // Opening the modal must be instant.  Use the matching eligibility index
    // for the initial suggestions; the search box remains available for every
    // registered account, including pending/offline drivers.
    query = {
      approvalStatus: 'APPROVED',
      kycStatus: 'APPROVED',
      onlineStatus: 'ONLINE',
      $and: [
        { $or: [{ activeBookingId: null }, { activeBookingId: { $exists: false } }] },
        { $or: [{ activeCommerceOrderId: null }, { activeCommerceOrderId: { $exists: false } }] },
      ],
    };
  }

  const cursor = db.collection('drivers').find(query, {
      projection: {
        userId:1, fullName:1, name:1, phone:1,
        approvalStatus:1, kycStatus:1, onlineStatus:1,
        approvedServiceCodes:1, serviceCapabilities:1, servicePreferences:1,
        activeBookingId:1, activeCommerceOrderId:1,
        rating:1, completedTrips:1, createdAt:1,
      },
    });
  if (sort) cursor.sort(sort);
  const drivers = await cursor.limit(safeLimit).toArray();
  return decorateCommerceDrivers(db, drivers, serviceCode);
}

async function dispatchCommerceReady({ db, order, notificationService, actorType = 'SYSTEM', actorId = null }) {
  if (!order) return { candidates: [] };
  const allowed = (['FOOD','ERRAND'].includes(order.serviceCode) && order.status === 'READY_FOR_PICKUP') ||
    (order.serviceCode === 'DELIVERY' && order.status === 'CREATED') ||
    (order.serviceCode === 'ERRAND' && !order.merchantId && order.status === 'CREATED');
  if (!allowed || order.driverId) return { candidates: [], skipped: 'ORDER_NOT_DISPATCHABLE' };
  const candidates = await eligibleCommerceDrivers(db, order.serviceCode, { onlineOnly: true });
  const now = new Date();
  const claimed = await db.collection('orders').updateOne(
    { _id: order._id, driverId: null, status: order.status },
    {
      $set: {
        dispatchStatus: candidates.length ? 'SEARCHING' : 'NO_DRIVER',
        dispatchStartedAt: now,
        dispatchCandidateCount: candidates.length,
        dispatchTriggeredBy: actorType,
        dispatchTriggeredById: actorId || null,
        dispatchUpdatedAt: now,
        updatedAt: now,
      },
      $inc: { dispatchAttempt: 1 },
      $push: {
        timeline: {
          status: 'DISPATCH_STARTED', at: now, actorType, actorId,
          meta: { candidateCount: candidates.length },
        },
      },
    },
  );
  if (!claimed.modifiedCount) return { candidates: [], skipped: 'ORDER_STATE_CHANGED' };
  const current = await db.collection('orders').findOne({ _id: order._id });
  const attempt = Number(current?.dispatchAttempt || 1);

  if (notificationService && candidates.length) {
    await Promise.all(candidates.map((driver) => notificationService.enqueue({
      dedupeKey: `COMMERCE:${String(order._id)}:READY:${attempt}:${String(driver._id)}`,
      type: 'COMMERCE_ORDER',
      targetType: 'DRIVER',
      targetId: driver._id,
      level: 2,
      title: order.serviceCode === 'FOOD' ? 'Có đơn đồ ăn sẵn sàng' : order.serviceCode === 'ERRAND' ? 'Có đơn mua hộ sẵn sàng' : 'Có đơn giao hàng mới',
      body: `${order.orderCode || 'Đơn mới'} · ${order.merchantSnapshot?.name || order.pickup?.address || 'Điểm lấy hàng'}`,
      data: { orderId: String(order._id), status: order.status, serviceCode: order.serviceCode },
    }).catch(() => null)));
  }
  return { candidates };
}

async function assignCommerceDriver({ db, order, driverId, notificationService, actorType = 'ADMIN', actorId = null }) {
  const driverObjectId = oid(driverId);
  if (!driverObjectId) throw new Error('Driver ID không hợp lệ.');
  const driver = await db.collection('drivers').findOne({ _id: driverObjectId });
  if (!driver || driver.approvalStatus !== 'APPROVED' || driver.kycStatus !== 'APPROVED') throw new Error('Tài xế chưa đủ điều kiện.');
  if (driver.onlineStatus !== 'ONLINE') throw new Error('Tài xế phải ONLINE để nhận đơn.');
  if (driver.activeBookingId || driver.activeCommerceOrderId) throw new Error('Tài xế đang bận.');
  if (!driverCanHandleCommerce(driver, order.serviceCode)) throw new Error('Tài xế chưa bật dịch vụ phù hợp.');
  await assertDriverPointsEligible(db, driver._id);
  const allowed = (['FOOD','ERRAND'].includes(order.serviceCode) && order.status === 'READY_FOR_PICKUP') ||
    (order.serviceCode === 'DELIVERY' && order.status === 'CREATED') ||
    (order.serviceCode === 'ERRAND' && !order.merchantId && order.status === 'CREATED');
  if (!allowed) throw new Error(`Đơn ${order.status} chưa thể điều phối.`);

  const now = new Date();
  const changed = await db.collection('orders').updateOne(
    { _id: order._id, driverId: null, status: order.status },
    {
      $set: { driverId: driver._id, status: 'DRIVER_ASSIGNED', assignedAt: now, dispatchStatus: 'ASSIGNED', updatedAt: now },
      $push: { timeline: { status:'DRIVER_ASSIGNED', at:now, actorType, actorId, meta:{ driverId:String(driver._id) } } },
    },
  );
  if (!changed.modifiedCount) throw new Error('Đơn đã được tài xế khác nhận hoặc trạng thái vừa thay đổi.');

  await db.collection('drivers').updateOne(
    { _id: driver._id, onlineStatus:'ONLINE' },
    { $set: { onlineStatus:'BUSY', activeCommerceOrderId: order._id, updatedAt:now } },
  );

  if (notificationService) {
    await notificationService.enqueue({
      dedupeKey:`COMMERCE:${String(order._id)}:ASSIGNED:${String(driver._id)}`,
      type:'COMMERCE_ORDER', targetType:'DRIVER', targetId:driver._id, level:2,
      title:'Đơn đã được điều phối cho bạn',
      body:`${order.orderCode || 'Đơn commerce'} · Mở mục Đơn dịch vụ để xử lý.`,
      data:{orderId:String(order._id),status:'DRIVER_ASSIGNED',serviceCode:order.serviceCode},
    }).catch(()=>{});
    if (order.customerId) {
      await notificationService.enqueue({
        dedupeKey:`COMMERCE:${String(order._id)}:CUSTOMER_ASSIGNED`,
        type:'COMMERCE_ORDER', targetType:'CUSTOMER', targetId:order.customerId,
        title:'Đã có tài xế nhận đơn', body:'Tài xế đang di chuyển đến điểm lấy hàng.',
        data:{orderId:String(order._id),status:'DRIVER_ASSIGNED',serviceCode:order.serviceCode},
      }).catch(()=>{});
    }
  }
  return db.collection('orders').findOne({ _id: order._id });
}

function createCommercePublicRouter({ getDb, requireCustomer, getPricing, getNotifications }) {
  const r = express.Router();
  r.get('/merchant-media/:merchantId/:filename', async (req,res) => {
    try {
      const merchantId = oid(req.params.merchantId);
      if (!merchantId) return res.status(400).json({ message:'Merchant ID không hợp lệ.' });
      const filename = path.basename(String(req.params.filename || ''));
      if (!filename) return res.status(404).end();
      const file = path.join(MERCHANT_MEDIA_ROOT, String(merchantId), filename);
      if (!fs.existsSync(file)) return res.status(404).end();
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(file);
    } catch (e) {
      return res.status(404).json({ message:'Không tìm thấy ảnh.' });
    }
  });
  r.get('/merchants', async (req,res) => {
    try {
      const q = { status: { $in:['ACTIVE','OPEN','BUSY'] } };
      if (req.query.category) q.categoryCode = String(req.query.category).toUpperCase();
      if (req.query.merchantType) q.merchantType = String(req.query.merchantType).toUpperCase();
      const rows = await getDb().collection('merchants').find(q).sort({ rating:-1, name:1 }).limit(100).toArray();
      res.json({ merchants: rows.filter(m=>reviewStatus(m)==='APPROVED').map(publicMerchantRecord) });
    } catch (e) { res.status(500).json({ message:e.message }); }
  });
  r.get('/merchants/:id/products', async (req,res) => {
    try {
      const merchantId = oid(req.params.id); if (!merchantId) return res.status(400).json({message:'Merchant ID không hợp lệ.'});
      const listedMerchant=await getDb().collection('merchants').findOne({_id:merchantId,status:{$in:['ACTIVE','OPEN','BUSY']}});if(!listedMerchant||reviewStatus(listedMerchant)!=='APPROVED')return res.status(404).json({message:'Cửa hàng chưa sẵn sàng nhận đơn.'});
      const products = await getDb().collection('products').find({ merchantId, status:'ACTIVE' }).sort({categoryName:1,sortOrder:1,name:1}).toArray();
      res.json({ products: products.map(serialize) });
    } catch (e) { res.status(500).json({ message:e.message }); }
  });
  r.post('/orders/quote', requireCustomer, async (req,res) => {
    try {
      const serviceCode = String(req.body?.serviceCode||'FOOD').toUpperCase();
      if (!['FOOD','DELIVERY','ERRAND'].includes(serviceCode)) return res.status(400).json({message:'Dịch vụ commerce không hợp lệ.'});
      const {distanceKm,durationMinutes}=await verifiedMetrics({pickup:req.body?.pickup,destination:req.body?.destination});
      const pricing = await getPricing().estimateFare({serviceCode,areaCode:req.body?.areaCode||'GLOBAL',distanceKm,durationMinutes});
      if (!pricing.available) return res.status(409).json({code:'FARE_UNAVAILABLE',message:pricing.reason});
      let fare={...pricing.fareSnapshot};
      let deliveryPolicy=null;
      if(serviceCode==='DELIVERY'){
        const baseFee=Number(fare.customerTotal||fare.total||0);
        const extra=await priceDeliveryExtras({db:getDb(),baseFee,details:req.body?.deliveryDetails,user:req.auth.user});
        fare={...fare,customerTotal:extra.total,total:extra.total,deliveryExtra:{preference:extra.preference,preferenceSurcharge:extra.preferenceSurcharge,fragileSurcharge:extra.fragileSurcharge,codAmount:extra.codAmount},breakdown:{...(fare.breakdown||{}),baseDeliveryFee:baseFee,preferenceSurcharge:extra.preferenceSurcharge,fragileSurcharge:extra.fragileSurcharge}};
        deliveryPolicy={codAllowed:extra.policy.cod.enabled&&(!extra.policy.cod.requireKyc||customerKycApproved(req.auth.user)),codEnabled:extra.policy.cod.enabled,requireKyc:extra.policy.cod.requireKyc};
      }
      res.json({ fare, deliveryPolicy });
    } catch(e){res.status(e.httpStatus||400).json({code:e.code||null,message:e.message});}
  });
  r.post('/orders', requireCustomer, async (req,res) => {
    try {
      const serviceCode = String(req.body?.serviceCode||'FOOD').toUpperCase();
      if (!['FOOD','DELIVERY','ERRAND'].includes(serviceCode)) return res.status(400).json({message:'serviceCode không hợp lệ.'});
      const merchantId = req.body?.merchantId ? oid(req.body.merchantId) : null;
      if (serviceCode==='FOOD' && !merchantId) return res.status(400).json({message:'Đơn FOOD phải có nhà hàng/cửa hàng.'});
      const db = getDb();
      const idempotencyKey=String(req.get('idempotency-key')||'').trim();
      if(idempotencyKey && !/^[A-Za-z0-9._:-]{12,128}$/.test(idempotencyKey))return res.status(400).json({code:'INVALID_IDEMPOTENCY_KEY',message:'Idempotency-Key phải gồm 12–128 ký tự hợp lệ.'});
      const requestDigest=idempotencyKey?crypto.createHash('sha256').update(JSON.stringify(req.body||{})).digest('hex'):null;
      const idemFilter=idempotencyKey?{customerId:req.auth.user._id,idempotencyKey}:null;
      if(idemFilter){
        const prior=await db.collection('orders').findOne(idemFilter);
        if(prior){
          if(prior.requestDigest!==requestDigest)return res.status(409).json({code:'IDEMPOTENCY_KEY_CONFLICT',message:'Khóa yêu cầu đã được dùng với nội dung khác.'});
          return res.status(200).json({order:serialize(prior),duplicate:true});
        }
      }
      let merchant = null;
      if (merchantId) {
        merchant = await db.collection('merchants').findOne({_id:merchantId,status:{$nin:['SUSPENDED','CLOSED_PERMANENTLY']}});
        if(!merchant) return res.status(404).json({message:'Không tìm thấy cửa hàng đang hoạt động.'});
        if(reviewStatus(merchant)!=='APPROVED'||!['ACTIVE','BUSY','OPEN'].includes(String(merchant.status).toUpperCase()))return res.status(409).json({message:'Cửa hàng chưa được duyệt hoặc đang tạm ngừng.'});
      }
      const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
      const items = [];
      let subtotal = 0;
      for (const item of rawItems) {
        const productId = oid(item.productId);
        if (!productId) continue;
        const product = await db.collection('products').findOne({_id:productId,merchantId,status:'ACTIVE'});
        if (!product) continue;
        const requestedQty=Number(item.quantity);
        if(!Number.isSafeInteger(requestedQty)||requestedQty<1||requestedQty>99) return res.status(400).json({message:'Số lượng sản phẩm phải là số nguyên từ 1 đến 99.'});
        const qty=requestedQty;
        const unitPrice=Number(product.price);
        if(!Number.isSafeInteger(unitPrice)||unitPrice<0) return res.status(409).json({message:'Giá sản phẩm chưa hợp lệ.'});
        const line=unitPrice*qty;
        if(!Number.isSafeInteger(line)||!Number.isSafeInteger(subtotal+line))return res.status(409).json({message:'Giá trị giỏ hàng vượt giới hạn.'});
        subtotal += line;
        items.push({productId:product._id,name:product.name,unitPrice:Number(product.price||0),quantity:qty,lineTotal:line});
      }
      if ((serviceCode==='FOOD' || (serviceCode==='ERRAND' && merchantId)) && !items.length) return res.status(400).json({message:'Giỏ hàng chưa có sản phẩm hợp lệ.'});
      const {distanceKm,durationMinutes}=await verifiedMetrics({pickup:req.body?.pickup,destination:req.body?.destination});
      const pricing = await getPricing().estimateFare({serviceCode,areaCode:req.body?.areaCode||'GLOBAL',distanceKm,durationMinutes});
      if (!pricing.available) return res.status(409).json({code:'FARE_UNAVAILABLE',message:pricing.reason});
      const baseDeliveryFee = Number(pricing.fareSnapshot?.customerTotal||pricing.fareSnapshot?.total||0);
      const deliveryExtra = serviceCode==='DELIVERY'
        ? await priceDeliveryExtras({db,baseFee:baseDeliveryFee,details:req.body?.deliveryDetails,user:req.auth.user})
        : {total:baseDeliveryFee,preference:'STANDARD',preferenceSurcharge:0,fragileSurcharge:0,codAmount:0};
      const deliveryFee = Number(deliveryExtra.total);
      if(!Number.isSafeInteger(deliveryFee)||deliveryFee<0||!Number.isSafeInteger(subtotal+deliveryFee))return res.status(409).json({code:'INVALID_FARE',message:'Không thể xác định giá đơn hàng hợp lệ.'});
      const fareSnapshot={...pricing.fareSnapshot,customerTotal:deliveryFee,total:deliveryFee,deliveryExtra:{preference:deliveryExtra.preference,preferenceSurcharge:deliveryExtra.preferenceSurcharge,fragileSurcharge:deliveryExtra.fragileSurcharge,codAmount:deliveryExtra.codAmount},breakdown:{...(pricing.fareSnapshot?.breakdown||{}),baseDeliveryFee,preferenceSurcharge:deliveryExtra.preferenceSurcharge,fragileSurcharge:deliveryExtra.fragileSurcharge}};
      const now = new Date();
      const doc = {
        orderCode:orderCode(),serviceCode,customerId:req.auth.user._id,
        ...(idempotencyKey?{idempotencyKey,requestDigest}:{}),merchantId,driverId:null,
        status:merchantId?'WAITING_MERCHANT':'CREATED',items,subtotal,deliveryFee,
        serviceFee:0,discount:0,
        total:subtotal+deliveryFee, // Only server-computed amounts are allowed here.
        fareSnapshot,
        pickup:req.body?.pickup||null,destination:req.body?.destination||null,
        customerNote:String(req.body?.customerNote||'').slice(0,500),paymentMethod:String(req.body?.paymentMethod||'CASH').toUpperCase(),paymentStatus:'UNPAID',
        deliveryDetails:req.body?.deliveryDetails && typeof req.body.deliveryDetails==='object' ? req.body.deliveryDetails : null,
        commerceDetails:req.body?.commerceDetails && typeof req.body.commerceDetails==='object' ? req.body.commerceDetails : null,
        merchantSnapshot:merchant?{name:merchant.name,address:merchant.address,location:merchant.location||null}:null,
        customerSnapshot:{fullName:req.auth.user.fullName,phone:req.auth.user.phone},
        timeline:[{status:merchantId?'WAITING_MERCHANT':'CREATED',at:now,actorType:'CUSTOMER',actorId:req.auth.user._id}],
        createdAt:now,updatedAt:now,
      };
      const result = await db.collection('orders').insertOne(doc); doc._id=result.insertedId;
      if(merchantId && getNotifications){
        const merchantUsers = await db.collection('merchant_users').find({merchantId,status:'ACTIVE'}).toArray().catch(()=>[]);
        for (const member of merchantUsers) {
          if (!member?.userId) continue;
          await getNotifications().enqueue({
            dedupeKey:`ORDER:${String(doc._id)}:MERCHANT_NEW:${String(member.userId)}`,
            type:'MERCHANT_ORDER_NEW',
            targetType:'MERCHANT',
            targetId:member.userId,
            title:'Đơn hàng mới',
            body:`Bạn có đơn ${doc.orderCode || ''} đang chờ xác nhận.`,
            data:{orderId:String(doc._id),status:doc.status,serviceCode:doc.serviceCode,orderCode:doc.orderCode||''},
          }).catch(()=>{});
        }
      }
      // DELIVERY does not wait for merchant approval: dispatch automatically as soon as the order exists.
      if(!merchantId && ['DELIVERY','ERRAND'].includes(serviceCode)){
        setImmediate(()=>dispatchCommerceReady({db,order:doc,notificationService:getNotifications?getNotifications():null,actorType:'SYSTEM'}).catch((error)=>console.error('[COMMERCE AUTO DISPATCH]',error.message)));
      }
      res.status(201).json({order:serialize(doc),autoDispatch:!merchantId});
    } catch(e){
      if(e?.code===11000 && req.get('idempotency-key')){
        const prior=await getDb().collection('orders').findOne({customerId:req.auth.user._id,idempotencyKey:String(req.get('idempotency-key')).trim()});
        if(prior){
          const incomingDigest=crypto.createHash('sha256').update(JSON.stringify(req.body||{})).digest('hex');
          if(prior.requestDigest!==incomingDigest)return res.status(409).json({code:'IDEMPOTENCY_KEY_CONFLICT',message:'Khóa yêu cầu đã được dùng với nội dung khác.'});
          return res.status(200).json({order:serialize(prior),duplicate:true});
        }
      }
      res.status(e.httpStatus|| (e?.code===11000?409:400)).json({code:e.code||null,message:e.message});
    }
  });
  r.get('/orders', requireCustomer, async (req,res) => {
    try { const rows=await getDb().collection('orders').find({customerId:req.auth.user._id}).sort({createdAt:-1}).limit(100).toArray();res.json({orders:rows.map(serialize)}); }
    catch(e){res.status(500).json({message:e.message});}
  });
  return r;
}

function createMerchantRouter({ getDb, getNotifications }) {
  const r = express.Router();
  r.use(...createRequireMerchant(getDb));
  async function notifyMerchantMembers({ merchantId, title, body, data = {}, type = 'MERCHANT_ALERT', dedupeKeyPrefix = 'MERCHANT_ALERT' }) {
    if (!getNotifications || !merchantId) return;
    const rows = await getDb().collection('merchant_users').find({ merchantId, status: 'ACTIVE' }).toArray().catch(() => []);
    for (const row of rows) {
      if (!row?.userId) continue;
      await getNotifications().enqueue({
        dedupeKey: `${dedupeKeyPrefix}:${String(merchantId)}:${String(row.userId)}`,
        type,
        targetType: 'MERCHANT',
        targetId: row.userId,
        title,
        body,
        data,
      }).catch(() => {});
    }
  }
  r.get('/me', (req,res)=>res.json({user:serialize(req.auth.user),membership:serialize(req.merchantContext.membership),merchant:serialize(req.merchantContext.merchant)}));
  r.get('/notifications', async (req,res)=>{
    try {
      const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30) || 30));
      const rows = await getDb().collection('notifications').find({ userId: req.auth.user._id, targetType: 'MERCHANT' }).sort({ createdAt: -1 }).limit(limit).toArray();
      return res.json({ notifications: rows.map(serialize) });
    } catch (e) {
      return res.status(500).json({ message: e.message });
    }
  });
  r.post('/notifications/:id/read', async (req,res)=>{
    try {
      const id = oid(req.params.id); if(!id) return res.status(400).json({ message:'Notification ID không hợp lệ.' });
      const now = new Date();
      await getDb().collection('notifications').updateOne({ _id:id, userId:req.auth.user._id, targetType:'MERCHANT' }, { $set:{ readAt: now, updatedAt: now } });
      return res.json({ ok:true });
    } catch (e) {
      return res.status(400).json({ message:e.message });
    }
  });
  r.post('/devices/register', async (req,res)=>{
    try {
      if(!getNotifications) return res.status(503).json({ message:'Notification service chưa sẵn sàng.' });
      return res.json(await getNotifications().registerDevice({ ...req.body, userId:req.auth.user._id, userType:'MERCHANT' }));
    } catch (e) {
      return res.status(400).json({ message:e.message });
    }
  });
  r.post('/devices/disable', async (req,res)=>{
    try {
      if(!req.body?.token && !req.body?.deviceId)return res.status(400).json({ message:'Thiếu token hoặc deviceId.' });
      if(!getNotifications) return res.status(503).json({ message:'Notification service chưa sẵn sàng.' });
      return res.json(await getNotifications().disableDevice({ userId:req.auth.user._id, token:req.body?.token, deviceId:req.body?.deviceId }));
    } catch (e) {
      return res.status(400).json({ message:e.message });
    }
  });
  // Merchants pending approval may edit their identity and upload evidence, but may not trade.
  r.use((req,res,next)=>{
    if (/^\/(?:me|store|verification|notifications|devices)(?:\/|$)/.test(req.path)) return next();
    if (reviewStatus(req.merchantContext.merchant)!=='APPROVED')
      return res.status(403).json({code:'MERCHANT_NOT_APPROVED',message:'Hồ sơ cửa hàng chưa được Admin duyệt.'});
    return next();
  });
  r.get('/dashboard', async (req,res)=>{
    try{
      const db=getDb(), merchantId=req.merchantContext.merchant._id;
      const start=new Date();start.setHours(0,0,0,0);
      const [newOrders,preparing,ready,completed,todayAgg]=await Promise.all([
        db.collection('orders').countDocuments({merchantId,status:'WAITING_MERCHANT'}),
        db.collection('orders').countDocuments({merchantId,status:{$in:['MERCHANT_ACCEPTED','PREPARING']}}),
        db.collection('orders').countDocuments({merchantId,status:'READY_FOR_PICKUP'}),
        db.collection('orders').countDocuments({merchantId,status:{$in:['DELIVERED','COMPLETED']},updatedAt:{$gte:start}}),
        db.collection('orders').aggregate([{$match:{merchantId,status:{$in:['DELIVERED','COMPLETED']},updatedAt:{$gte:start}}},{$group:{_id:null,gross:{$sum:'$subtotal'},orders:{$sum:1}}}]).toArray(),
      ]);
      res.json({newOrders,preparing,ready,completedToday:completed,grossToday:todayAgg[0]?.gross||0,orderCountToday:todayAgg[0]?.orders||0,merchant:serialize(req.merchantContext.merchant)});
    }catch(e){res.status(500).json({message:e.message});}
  });
  r.get('/orders', async (req,res)=>{
    try{const q={merchantId:req.merchantContext.merchant._id};if(req.query.status)q.status=String(req.query.status).toUpperCase();const rows=await getDb().collection('orders').find(q).sort({createdAt:-1}).limit(200).toArray();res.json({orders:rows.map(serialize)});}catch(e){res.status(500).json({message:e.message});}
  });
  r.put('/orders/:id/status', async (req,res)=>{
    try{
      const db=getDb(),_id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Order ID không hợp lệ.'});
      const current=await db.collection('orders').findOne({_id,merchantId:req.merchantContext.merchant._id});if(!current)return res.status(404).json({message:'Không tìm thấy đơn.'});
      const next=String(req.body?.status||'').toUpperCase();
      if(!ORDER_STATUSES.includes(next))return res.status(400).json({message:'Trạng thái không hợp lệ.'});
      const allowed=MERCHANT_TRANSITIONS[current.status]||[];
      if(!allowed.includes(next))return res.status(409).json({message:`Merchant không thể chuyển ${current.status} → ${next}.`});
      const now=new Date();
      const stateUpdate=await db.collection('orders').updateOne({_id,merchantId:req.merchantContext.merchant._id,status:current.status},{$set:{status:next,updatedAt:now,...(next==='READY_FOR_PICKUP'?{readyAt:now}:{}),...(next==='CANCELLED'?{cancelledAt:now,cancelReason:String(req.body?.reason||'MERCHANT_CANCELLED')}: {})},$push:{timeline:{status:next,at:now,actorType:'MERCHANT',actorId:req.auth.user._id}}});
      if(stateUpdate.matchedCount!==1)return res.status(409).json({code:'ORDER_STATE_CHANGED',message:'Đơn hàng đã đổi trạng thái trên thiết bị khác. Vui lòng tải lại.'});
      let updatedOrder=await db.collection('orders').findOne({_id});
      let dispatchResult=null;
      if(next==='READY_FOR_PICKUP' && updatedOrder){
        dispatchResult=await dispatchCommerceReady({
          db, order:updatedOrder,
          notificationService:getNotifications?getNotifications():null,
          actorType:'MERCHANT', actorId:req.auth.user._id,
        });
        await db.collection('audit_logs').insertOne({
          actorType:'MERCHANT',
          actorId:req.auth.user._id,
          action:'COMMERCE_READY_DISPATCH',
          entityType:'ORDER',
          entityId:String(_id),
          after:{
            serviceCode:updatedOrder.serviceCode,
            merchantId:String(req.merchantContext.merchant._id),
            candidateCount:Number(dispatchResult?.candidates?.length||0),
          },
          createdAt:new Date(),
        }).catch(()=>{});
        updatedOrder=await db.collection('orders').findOne({_id});
      }
      if(getNotifications && updatedOrder?.customerId){
        const labels={MERCHANT_ACCEPTED:['Cửa hàng đã xác nhận','Đơn hàng của bạn đã được cửa hàng xác nhận.'],PREPARING:['Đang chuẩn bị','Cửa hàng đang chuẩn bị đơn hàng của bạn.'],READY_FOR_PICKUP:['Sẵn sàng lấy hàng','Đơn đã sẵn sàng để tài xế đến nhận.'],CANCELLED:['Đơn đã bị hủy','Cửa hàng không thể tiếp tục xử lý đơn này.']};
        const msg=labels[next];
        if(msg) await getNotifications().enqueue({dedupeKey:`ORDER:${String(_id)}:${next}`,type:'COMMERCE_ORDER',targetType:'CUSTOMER',targetId:updatedOrder.customerId,title:msg[0],body:msg[1],data:{orderId:String(_id),status:next,serviceCode:updatedOrder.serviceCode}}).catch(()=>{});
      }
      res.json({
        order:serialize(updatedOrder),
        dispatch:dispatchResult?{
          candidateCount:Number(dispatchResult.candidates?.length||0),
          status:Number(dispatchResult.candidates?.length||0)>0?'SEARCHING':'NO_DRIVER',
        }:null,
      });
    }catch(e){res.status(400).json({message:e.message});}
  });
  r.get('/products', async (req,res)=>{try{const rows=await getDb().collection('products').find({merchantId:req.merchantContext.merchant._id}).sort({categoryName:1,sortOrder:1,name:1}).toArray();res.json({products:rows.map(serialize)});}catch(e){res.status(500).json({message:e.message});}});
  r.post('/products', async (req,res)=>{
    try{const now=new Date();const doc={merchantId:req.merchantContext.merchant._id,name:String(req.body?.name||'').trim(),description:String(req.body?.description||'').trim(),categoryName:String(req.body?.categoryName||'Khác').trim(),price:Math.max(0,Number(req.body?.price||0)),imageUrl:req.body?.imageUrl||null,status:String(req.body?.status||'ACTIVE').toUpperCase(),stockStatus:String(req.body?.stockStatus||'AVAILABLE').toUpperCase(),sortOrder:Number(req.body?.sortOrder||0),createdAt:now,updatedAt:now};if(doc.name.length<2)return res.status(400).json({message:'Tên sản phẩm quá ngắn.'});const x=await getDb().collection('products').insertOne(doc);doc._id=x.insertedId;res.status(201).json({product:serialize(doc)});}catch(e){res.status(400).json({message:e.message});}
  });
  r.put('/products/:id', async (req,res)=>{
    try{const _id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Product ID không hợp lệ.'});const patch={};for(const k of ['name','description','categoryName','imageUrl','status','stockStatus','sortOrder'])if(req.body?.[k]!==undefined)patch[k]=req.body[k];if(req.body?.price!==undefined)patch.price=Math.max(0,Number(req.body.price||0));patch.updatedAt=new Date();const x=await getDb().collection('products').updateOne({_id,merchantId:req.merchantContext.merchant._id},{$set:patch});if(!x.matchedCount)return res.status(404).json({message:'Không tìm thấy sản phẩm.'});res.json({product:serialize(await getDb().collection('products').findOne({_id}))});}catch(e){res.status(400).json({message:e.message});}
  });
  // Upload a real product photo; only the owning merchant can replace it.
  r.post('/products/:id/media', merchantMediaUpload.single('image'), async (req,res)=>{
    try {
      const _id=oid(req.params.id);
      if(!_id){if(req.file?.path)fs.promises.unlink(req.file.path).catch(()=>{});return res.status(400).json({message:'Product ID không hợp lệ.'});}
      const merchantId=req.merchantContext.merchant._id;
      const product=await getDb().collection('products').findOne({_id,merchantId});
      if(!product){if(req.file?.path)fs.promises.unlink(req.file.path).catch(()=>{});return res.status(404).json({message:'Món ăn không thuộc cửa hàng này.'});}
      if(!req.file)return res.status(400).json({message:'Chưa chọn ảnh món ăn.'});
      const detected=verifiedReviewMime(fs.readFileSync(req.file.path).subarray(0,32));
      const declared=String(req.file.mimetype||'').toLowerCase().replace('image/jpg','image/jpeg');
      if(!detected||detected!==declared){fs.promises.unlink(req.file.path).catch(()=>{});return res.status(415).json({message:'Nội dung file không phải ảnh JPG, PNG hoặc WEBP hợp lệ.'});}
      const url=merchantMediaPublicPath(merchantId,req.file.filename);
      await getDb().collection('products').updateOne({_id,merchantId},{$set:{imageUrl:url,updatedAt:new Date()}});
      deleteOldMerchantMedia(product.imageUrl,merchantId);
      return res.json({product:serialize(await getDb().collection('products').findOne({_id,merchantId})),url});
    }catch(e){if(req.file?.path)fs.promises.unlink(req.file.path).catch(()=>{});return res.status(400).json({message:e.message});}
  });
  r.get('/store', (req,res)=>res.json({merchant:serialize(req.merchantContext.merchant)}));
  r.put('/store', async (req,res)=>{
    try{const patch={};for(const k of ['name','address','description','openingHours','pickupInstruction','categoryName'])if(req.body?.[k]!==undefined)patch[k]=String(req.body[k]).slice(0,400);if(req.body?.status!==undefined){const status=String(req.body.status).toUpperCase();if(!['ACTIVE','BUSY','PAUSED'].includes(status))return res.status(400).json({message:'Trạng thái hoạt động không hợp lệ.'});if(reviewStatus(req.merchantContext.merchant)!=='APPROVED')return res.status(403).json({message:'Cửa hàng chưa được duyệt, không thể mở nhận đơn.'});patch.status=status;}if(reviewStatus(req.merchantContext.merchant)==='APPROVED' && (req.body?.name!==undefined || req.body?.address!==undefined || req.body?.merchantType!==undefined))return res.status(409).json({message:'Thay đổi tên, địa chỉ hoặc loại hình cửa hàng đã duyệt cần liên hệ Admin.'});if(req.body?.merchantType!==undefined){const type=String(req.body.merchantType).toUpperCase();if(!['STORE','RESTAURANT'].includes(type))return res.status(400).json({message:'merchantType phải là STORE hoặc RESTAURANT.'});patch.merchantType=type;patch.merchantTypeLabel=type==='RESTAURANT'?'Nhà hàng · Food':'Cửa hàng · Đặt hộ';patch.categoryCode=type==='RESTAURANT'?'FOOD':'ERRAND';}patch.updatedAt=new Date();await getDb().collection('merchants').updateOne({_id:req.merchantContext.merchant._id},{$set:patch});res.json({merchant:serialize(await getDb().collection('merchants').findOne({_id:req.merchantContext.merchant._id}))});}catch(e){res.status(400).json({message:e.message});}
  });
  r.post('/store/media/:kind', merchantMediaUpload.single('image'), async (req,res)=>{
    try {
      const kind=String(req.params.kind||'').toLowerCase();
      if(!['logo','cover'].includes(kind))return res.status(400).json({message:'kind phải là logo hoặc cover.'});
      if(!req.file)return res.status(400).json({message:'Chưa chọn file ảnh.'});
      const detected=verifiedReviewMime(fs.readFileSync(req.file.path).subarray(0,32));
      const declared=String(req.file.mimetype||'').toLowerCase().replace('image/jpg','image/jpeg');
      if(!detected || declared!==detected){
        fs.promises.unlink(req.file.path).catch(()=>{});
        return res.status(415).json({message:'Tệp không phải ảnh JPG, PNG hoặc WEBP hợp lệ.'});
      }
      const merchantId=req.merchantContext.merchant._id;
      const field=kind==='logo'?'logoUrl':'coverUrl';
      const current=await getDb().collection('merchants').findOne({_id:merchantId});
      const mediaUrl=merchantMediaPublicPath(merchantId,req.file.filename);
      await getDb().collection('merchants').updateOne(
        {_id:merchantId},
        {$set:{[field]:mediaUrl,updatedAt:new Date()}},
      );
      deleteOldMerchantMedia(current?.[field],merchantId);
      const merchant=await getDb().collection('merchants').findOne({_id:merchantId});
      return res.json({merchant:serialize(merchant),kind,url:mediaUrl});
    } catch(e) {
      if(req.file?.path)fs.promises.unlink(req.file.path).catch(()=>{});
      return res.status(400).json({message:e.message});
    }
  });
  r.get('/verification', async(req,res)=>{
    const merchant=await getDb().collection('merchants').findOne({_id:req.merchantContext.merchant._id});
    return res.json({verification:reviewSummary(merchant)});
  });
  r.post('/verification/documents/:kind', (req,res,next)=>{
    if(!DOCUMENT_TYPES.includes(String(req.params.kind||'').toUpperCase()))return res.status(400).json({message:'Loại giấy tờ không hợp lệ.'});
    if(reviewStatus(req.merchantContext.merchant)==='APPROVED')return res.status(409).json({message:'Hồ sơ đã duyệt; liên hệ Admin nếu cần thay đổi giấy tờ.'});
    return next();
  },merchantReviewUpload.single('image'),async(req,res)=>{
    try{
      if(!req.file)return res.status(400).json({message:'Chọn ảnh JPG, PNG hoặc WEBP dưới 5 MB.'});
      const magic=verifiedReviewMime(await fs.promises.readFile(req.file.path));
      if(!magic){await fs.promises.unlink(req.file.path).catch(()=>{});return res.status(400).json({message:'File ảnh không hợp lệ.'});}
      const merchantId=req.merchantContext.merchant._id,kind=String(req.params.kind).toUpperCase();
      const d={filename:req.file.filename,originalName:path.basename(String(req.file.originalname||'image')).slice(0,120),size:req.file.size,mime:magic,uploadedAt:new Date()};
      const before=await getDb().collection('merchants').findOne({_id:merchantId});
      const updated=await getDb().collection('merchants').updateOne({_id:merchantId,approvalStatus:{$ne:'APPROVED'},status:{$ne:'ACTIVE'}},{$set:{['reviewDocuments.'+kind]:d,updatedAt:new Date()}});
      if(!updated.matchedCount){await fs.promises.unlink(req.file.path).catch(()=>{});return res.status(409).json({message:'Trạng thái hồ sơ vừa thay đổi.'});}
      const old=before?.reviewDocuments?.[kind]?.filename;
      if(old && /^[a-f0-9]{40}\.img$/.test(old) && old!==d.filename)fs.promises.unlink(path.join(MERCHANT_REVIEW_ROOT,String(merchantId),old)).catch(()=>{});
      return res.json({verification:reviewSummary(await getDb().collection('merchants').findOne({_id:merchantId}))});
    }catch(e){if(req.file?.path)await fs.promises.unlink(req.file.path).catch(()=>{});return res.status(500).json({message:'Không lưu được giấy tờ.'});}
  });
  r.post('/verification/submit',async(req,res)=>{
    try {
      const db=getDb(),id=req.merchantContext.merchant._id,merchant=await db.collection('merchants').findOne({_id:id});
      if(reviewStatus(merchant)==='APPROVED')return res.status(409).json({message:'Hồ sơ đã được duyệt.'});
      const missing=missingReviewItems(merchant);if(missing.length)return res.status(400).json({message:'Hồ sơ chưa đầy đủ.',missing});
      const result=await db.collection('merchants').updateOne({_id:id,approvalStatus:{$ne:'APPROVED'},status:{$in:['PENDING','REJECTED']}},{$set:{approvalStatus:'PENDING',status:'PENDING',reviewReason:'',submittedAt:new Date(),updatedAt:new Date()}});
      if(!result.matchedCount)return res.status(409).json({message:'Không thể gửi lại hồ sơ ở trạng thái này.'});
      return res.json({verification:reviewSummary(await db.collection('merchants').findOne({_id:id}))});
    }catch(e){return res.status(500).json({message:'Gửi hồ sơ thất bại.'});}
  });
  r.get('/verification/documents/:kind',async(req,res)=>{
    const merchant=await getDb().collection('merchants').findOne({_id:req.merchantContext.merchant._id});
    const kind=String(req.params.kind||'').toUpperCase();
    if(!DOCUMENT_TYPES.includes(kind))return res.status(400).json({message:'Loại giấy tờ không hợp lệ.'});
    return sendReviewDocument(res,merchant,kind);
  });
  r.get('/settlements', async (req,res)=>{try{const rows=await getDb().collection('merchant_settlements').find({merchantId:req.merchantContext.merchant._id}).sort({periodEnd:-1,createdAt:-1}).limit(100).toArray();res.json({settlements:rows.map(serialize)});}catch(e){res.status(500).json({message:e.message});}});
  return r;
}


function createCommerceDriverRouter({ getDb, requireApprovedDriver, findDriverByPhone, getNotifications }) {
  const r=express.Router();
  r.use(requireApprovedDriver);
  async function driver(req,res){const found=await findDriverByPhone(req.auth.user.phone);if(!found){res.status(404).json({message:'Không tìm thấy tài xế.'});return null;}return found;}
  r.get('/orders/available', async (req,res)=>{
    try{
      const found=await driver(req,res);if(!found)return;
      if(found.driver.onlineStatus!=='ONLINE' || found.driver.activeBookingId || found.driver.activeCommerceOrderId){
        return res.json({orders:[]});
      }
      const pointState=await assertDriverPointsEligible(getDb(),found.driver._id).catch(()=>null);
      if(!pointState)return res.json({orders:[],pointStatus:'BLOCKED'});
      const rows=await getDb().collection('orders').find({
        driverId:null,
        $or:[
          {serviceCode:{$in:['FOOD','ERRAND']},status:'READY_FOR_PICKUP'},
          {serviceCode:'DELIVERY',status:'CREATED'},
          {serviceCode:'ERRAND',merchantId:null,status:'CREATED'},
        ],
      }).sort({readyAt:1,createdAt:1}).limit(80).toArray();
      const eligible=rows.filter((order)=>driverCanHandleCommerce(found.driver,order.serviceCode)).slice(0,30);
      res.json({orders:eligible.map(serialize)});
    }catch(e){res.status(500).json({message:e.message});}
  });
  r.get('/orders/active', async (req,res)=>{
    try{const found=await driver(req,res);if(!found)return;const row=await getDb().collection('orders').findOne({driverId:found.driver._id,status:{$in:['DRIVER_ASSIGNED','DRIVER_AT_MERCHANT','PICKED_UP','DELIVERING','DELIVERED']}},{sort:{updatedAt:-1}});res.json({order:serialize(row)});}catch(e){res.status(500).json({message:e.message});}
  });
  r.post('/orders/:id/accept', async (req,res)=>{
    try{
      const found=await driver(req,res);if(!found)return;
      const _id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Order ID không hợp lệ.'});
      const current=await getDb().collection('orders').findOne({_id});if(!current)return res.status(404).json({message:'Không tìm thấy đơn.'});
      const allowed=([ 'FOOD','ERRAND' ].includes(current.serviceCode)&&current.status==='READY_FOR_PICKUP')||(current.serviceCode==='DELIVERY'&&current.status==='CREATED')||(current.serviceCode==='ERRAND'&&!current.merchantId&&current.status==='CREATED');
      if(!allowed)return res.status(409).json({message:'Đơn không còn sẵn sàng để nhận.'});
      if(found.driver.onlineStatus!=='ONLINE')return res.status(409).json({message:'Tài xế phải ONLINE để nhận đơn.'});
      if(found.driver.activeBookingId||found.driver.activeCommerceOrderId)return res.status(409).json({message:'Tài xế đang có chuyến/đơn hoạt động.'});
      if(!driverCanHandleCommerce(found.driver,current.serviceCode))return res.status(403).json({message:'Tài xế chưa bật loại dịch vụ phù hợp.'});
      await assertDriverPointsEligible(getDb(),found.driver._id);
      const now=new Date();
      const x=await getDb().collection('orders').updateOne({_id,driverId:null,status:current.status},{$set:{driverId:found.driver._id,status:'DRIVER_ASSIGNED',assignedAt:now,dispatchStatus:'ASSIGNED',updatedAt:now},$push:{timeline:{status:'DRIVER_ASSIGNED',at:now,actorType:'DRIVER',actorId:found.driver._id}}});
      if(!x.modifiedCount)return res.status(409).json({message:'Đơn vừa được tài xế khác nhận.'});
      await getDb().collection('drivers').updateOne({_id:found.driver._id,onlineStatus:'ONLINE'},{$set:{onlineStatus:'BUSY',activeCommerceOrderId:_id,updatedAt:now}});
      const updatedOrder=await getDb().collection('orders').findOne({_id});
      if(getNotifications&&updatedOrder?.customerId)await getNotifications().enqueue({dedupeKey:`ORDER:${String(_id)}:DRIVER_ASSIGNED`,type:'COMMERCE_ORDER',targetType:'CUSTOMER',targetId:updatedOrder.customerId,title:'Đã có tài xế nhận đơn',body:'Tài xế đang di chuyển đến điểm lấy hàng.',data:{orderId:String(_id),status:'DRIVER_ASSIGNED',serviceCode:updatedOrder.serviceCode}}).catch(()=>{});
      res.json({order:serialize(updatedOrder)});
    }catch(e){res.status(400).json({message:e.message});}
  });
  r.post('/orders/:id/status', async (req,res)=>{
    try{const found=await driver(req,res);if(!found)return;const _id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Order ID không hợp lệ.'});const current=await getDb().collection('orders').findOne({_id,driverId:found.driver._id});if(!current)return res.status(404).json({message:'Không tìm thấy đơn của tài xế.'});const next=String(req.body?.status||'').toUpperCase();const transitions={DRIVER_ASSIGNED:['DRIVER_AT_MERCHANT','PICKED_UP'],DRIVER_AT_MERCHANT:['PICKED_UP'],PICKED_UP:['DELIVERING'],DELIVERING:['DELIVERED'],DELIVERED:['COMPLETED']};if(!(transitions[current.status]||[]).includes(next))return res.status(409).json({message:`Không thể chuyển ${current.status} → ${next}.`});const now=new Date();await getDb().collection('orders').updateOne({_id},{$set:{status:next,updatedAt:now,...(next==='PICKED_UP'?{pickedUpAt:now}:{}),...(next==='DELIVERED'?{deliveredAt:now}:{}),...(next==='COMPLETED'?{completedAt:now,paymentStatus:String(current.paymentMethod||'CASH').toUpperCase()==='CASH'?'PAID':current.paymentStatus}: {})},$push:{timeline:{status:next,at:now,actorType:'DRIVER',actorId:found.driver._id}}});const updatedOrder=await getDb().collection('orders').findOne({_id});if(next==='COMPLETED'){await getDb().collection('drivers').updateOne({_id:found.driver._id,activeCommerceOrderId:_id},{$set:{onlineStatus:'ONLINE',activeCommerceOrderId:null,updatedAt:now}});}if(getNotifications&&updatedOrder?.customerId){const labels={DRIVER_AT_MERCHANT:['Tài xế đã đến điểm lấy','Tài xế đang chờ nhận đơn của bạn.'],PICKED_UP:['Tài xế đã nhận đơn','Đơn hàng đang được chuẩn bị giao đến bạn.'],DELIVERING:['Đang giao đến bạn','Tài xế đang di chuyển đến địa chỉ nhận.'],DELIVERED:['Đã giao hàng','Đơn đã được giao.'],COMPLETED:['Đơn đã hoàn thành','Cảm ơn bạn đã sử dụng TH79 iMove.']};const msg=labels[next];if(msg)await getNotifications().enqueue({dedupeKey:`ORDER:${String(_id)}:${next}`,type:'COMMERCE_ORDER',targetType:'CUSTOMER',targetId:updatedOrder.customerId,title:msg[0],body:msg[1],data:{orderId:String(_id),status:next,serviceCode:updatedOrder.serviceCode}}).catch(()=>{});}res.json({order:serialize(updatedOrder)});}catch(e){res.status(400).json({message:e.message});}
  });
  return r;
}

function createCommerceAdminRouter({ getDb, getNotifications }) {
  const r=express.Router();const {requireAdmin,permit}=createAdminGuard({getDb});r.use(requireAdmin);
  r.get('/delivery-policy',permit('orders.view'),async(_req,res)=>{try{res.json({policy:await getDeliveryPolicy(getDb())});}catch(e){res.status(500).json({message:e.message});}});
  r.put('/delivery-policy',permit('orders.policy.manage'),async(req,res)=>{try{const db=getDb(),now=new Date();const current=await getDeliveryPolicy(db);const policy={standard:normalizeFeeRule(req.body?.standard,current.standard),priority:normalizeFeeRule(req.body?.priority,current.priority),fragile:normalizeFeeRule(req.body?.fragile,current.fragile),cod:{enabled:Boolean(req.body?.cod?.enabled),requireKyc:req.body?.cod?.requireKyc!==false},updatedAt:now,updatedBy:req.admin._id};await db.collection('commerce_settings').updateOne({_id:'DELIVERY_FEE_POLICY'},{$set:policy},{upsert:true});await db.collection('audit_logs').insertOne({actorType:'ADMIN',actorId:req.admin._id,action:'DELIVERY_POLICY_UPDATE',entityType:'COMMERCE_SETTING',entityId:'DELIVERY_FEE_POLICY',after:policy,createdAt:now});res.json({policy});}catch(e){res.status(400).json({message:e.message});}});
  r.get('/merchants',permit('merchants.view'),async(req,res)=>{try{const rows=await getDb().collection('merchants').find({}).sort({createdAt:-1}).limit(500).toArray();res.json({merchants:rows.map(adminMerchantRecord)});}catch(e){res.status(500).json({message:e.message});}});
  r.get('/merchants/:id',permit('merchants.view'),async(req,res)=>{
    const id=oid(req.params.id);if(!id)return res.status(400).json({message:'Merchant ID không hợp lệ.'});
    const merchant=await getDb().collection('merchants').findOne({_id:id});
    if(!merchant)return res.status(404).json({message:'Không tìm thấy cửa hàng.'});
    return res.json({merchant:adminMerchantRecord(merchant)});
  });
  r.get('/merchants/:id/documents/:kind',permit('merchants.approve'),async(req,res)=>{
    const id=oid(req.params.id),kind=String(req.params.kind||'').toUpperCase();
    if(!id||!DOCUMENT_TYPES.includes(kind))return res.status(400).json({message:'Yêu cầu không hợp lệ.'});
    const merchant=await getDb().collection('merchants').findOne({_id:id});
    if(!merchant)return res.status(404).json({message:'Không tìm thấy cửa hàng.'});
    return sendReviewDocument(res,merchant,kind);
  });
  r.post('/merchants/:id/review',permit('merchants.approve'),async(req,res)=>{
    try{
      const id=oid(req.params.id);if(!id)return res.status(400).json({message:'Merchant ID không hợp lệ.'});
      const decision=String(req.body?.decision||'').toUpperCase();
      if(!['APPROVE','REJECT'].includes(decision))return res.status(400).json({message:'Quyết định không hợp lệ.'});
      const reason=String(req.body?.reason||'').trim().slice(0,500);
      if(decision==='REJECT' && reason.length<8)return res.status(400).json({message:'Cần nhập lý do từ chối (tối thiểu 8 ký tự).'});
      const db=getDb(),current=await db.collection('merchants').findOne({_id:id});
      if(!current)return res.status(404).json({message:'Không tìm thấy cửa hàng.'});
      if(reviewStatus(current)!=='PENDING')return res.status(409).json({message:'Chỉ được xét duyệt hồ sơ đang chờ xử lý.'});
      if(decision==='APPROVE'){
        const missing=missingReviewItems(current);
        if(missing.length)return res.status(422).json({message:'Hồ sơ chưa đủ điều kiện duyệt.',missing});
      }
      const now=new Date(),next=decision==='APPROVE'?'APPROVED':'REJECTED';
      const filter={_id:id,status:'PENDING',approvalStatus:current.approvalStatus||{$exists:false}};
      const patch={approvalStatus:next,status:decision==='APPROVE'?'ACTIVE':'REJECTED',reviewReason:decision==='REJECT'?reason:'',reviewedAt:now,reviewedBy:req.admin._id,updatedAt:now};
      const update=await db.collection('merchants').updateOne(filter,{$set:patch});
      if(!update.matchedCount)return res.status(409).json({message:'Hồ sơ đã được người khác xử lý. Vui lòng tải lại.'});
      try{await db.collection('audit_logs').insertOne({actorType:'ADMIN',actorId:req.admin._id,action:decision==='APPROVE'?'MERCHANT_APPROVED':'MERCHANT_REJECTED',entityType:'MERCHANT',entityId:String(id),before:{approvalStatus:reviewStatus(current),status:current.status},after:patch,createdAt:now});}
      catch(error){console.error('[MERCHANT REVIEW AUDIT]',error.message);}
      const merchant=await db.collection('merchants').findOne({_id:id});
      if(getNotifications){
        const merchantUsers = await db.collection('merchant_users').find({ merchantId:id, status:'ACTIVE' }).toArray().catch(() => []);
        for (const row of merchantUsers) {
          if (!row?.userId) continue;
          await getNotifications().enqueue({
            dedupeKey: `${decision==='APPROVE' ? 'MERCHANT_APPROVED' : 'MERCHANT_REJECTED'}:${String(id)}:${now.getTime()}:${String(row.userId)}`,
            type: decision==='APPROVE' ? 'MERCHANT_APPROVED' : 'MERCHANT_REJECTED',
            targetType: 'MERCHANT',
            targetId: row.userId,
            title: decision==='APPROVE' ? 'Hồ sơ cửa hàng đã được duyệt' : 'Hồ sơ cửa hàng bị từ chối',
            body: decision==='APPROVE' ? 'Cửa hàng của bạn đã được Admin phê duyệt và có thể nhận đơn.' : `Admin đã từ chối hồ sơ. ${reason || 'Hãy cập nhật lại giấy tờ và gửi lại.'}`,
            data:{ merchantId:String(id), approvalStatus:next, reviewReason:reason || '' },
          }).catch(()=>{});
        }
      }
      return res.json({merchant:adminMerchantRecord(merchant)});
    }catch(e){console.error('[MERCHANT REVIEW]',e);return res.status(500).json({message:'Không xử lý được hồ sơ.'});}
  });
  r.put('/merchants/:id',permit('merchants.manage'),async(req,res)=>{try{const _id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Merchant ID không hợp lệ.'});const patch={};for(const k of ['name','commissionRate','categoryCode','merchantType','merchantTypeLabel','categoryName','logoUrl','coverUrl'])if(req.body?.[k]!==undefined)patch[k]=req.body[k];if(req.body?.status!==undefined){const status=String(req.body.status).toUpperCase();if(!['ACTIVE','BUSY','PAUSED','SUSPENDED'].includes(status))return res.status(400).json({message:'Trạng thái hoạt động không hợp lệ.'});const current=await getDb().collection('merchants').findOne({_id});if(!current)return res.status(404).json({message:'Không tìm thấy cửa hàng.'});if(reviewStatus(current)!=='APPROVED')return res.status(409).json({message:'Phải duyệt hồ sơ trước khi đổi trạng thái hoạt động.'});patch.status=status;}patch.updatedAt=new Date();await getDb().collection('merchants').updateOne({_id},{$set:patch});await getDb().collection('audit_logs').insertOne({actorType:'ADMIN',actorId:req.admin._id,action:'MERCHANT_UPDATE',entityType:'MERCHANT',entityId:String(_id),after:patch,createdAt:new Date()});res.json({merchant:adminMerchantRecord(await getDb().collection('merchants').findOne({_id}))});}catch(e){res.status(400).json({message:e.message});}});
  r.get('/orders',permit('orders.view'),async(req,res)=>{
    try{
      const q={serviceCode:{$in:COMMERCE_SERVICE_CODES}};
      if(req.query.status)q.status=String(req.query.status).toUpperCase();
      if(req.query.serviceCode){
        const serviceCode=String(req.query.serviceCode).toUpperCase();
        if(!COMMERCE_SERVICE_CODES.includes(serviceCode))return res.status(400).json({message:'serviceCode commerce không hợp lệ.'});
        q.serviceCode=serviceCode;
      }
      const requestedLimit=Number(req.query.limit||ADMIN_COMMERCE_ORDERS_LIMIT);
      const limit=Math.max(1,Math.min(ADMIN_COMMERCE_ORDERS_MAX_LIMIT,Number.isFinite(requestedLimit)?requestedLimit:ADMIN_COMMERCE_ORDERS_LIMIT));
      const requestedPage=Number(req.query.page||1);
      const page=Math.max(1,Math.min(10000,Number.isFinite(requestedPage)?Math.floor(requestedPage):1));
      // Fetch one extra record instead of countDocuments: it keeps this query
      // index-friendly while still letting the web app enable "Trang sau".
      const rows=await getDb().collection('orders').find(q,{
        maxTimeMS:12000,
        projection:{orderCode:1,serviceCode:1,merchantId:1,merchantSnapshot:1,pickup:1,customerSnapshot:1,status:1,dispatchStatus:1,dispatchCandidateCount:1,dispatchTriggeredBy:1,driverId:1,total:1,deliveryFee:1,createdAt:1},
      }).sort({createdAt:-1}).skip((page-1)*limit).limit(limit+1).toArray();
      const hasNext=rows.length>limit;
      res.json({orders:rows.slice(0,limit).map(serialize),limit,page,hasNext,hasPrevious:page>1});
    }catch(e){
      const timedOut=e?.code===50||/time limit|maxtime/i.test(String(e?.message||''));
      res.status(timedOut?503:500).json({code:timedOut?'COMMERCE_QUERY_TIMEOUT':'COMMERCE_QUERY_FAILED',message:timedOut?'Truy vấn đơn commerce quá thời gian. Backend sẽ tự thử lại khi dữ liệu sẵn sàng.':e.message});
    }
  });
  r.get('/orders/:id/candidates',permit('orders.view'),async(req,res)=>{
    try{
      const _id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Order ID không hợp lệ.'});
      const order=await getDb().collection('orders').findOne({_id});if(!order)return res.status(404).json({message:'Không tìm thấy đơn.'});
      const requestedLimit=Number(req.query?.limit||50);
      const limit=Math.max(1,Math.min(100,Number.isFinite(requestedLimit)?requestedLimit:50));
      const drivers=await getCommerceDispatchRoster(getDb(),order.serviceCode,{search:req.query?.q,limit});
      res.json({order:serialize(order),drivers:drivers.map((d)=>({id:String(d._id),fullName:d.fullName,phone:d.phone,onlineStatus:d.onlineStatus||'OFFLINE',approvalStatus:d.approvalStatus||'PENDING',kycStatus:d.kycStatus||'INCOMPLETE',rating:Number(d.rating||0),completedTrips:Number(d.completedTrips||0),pointBalance:Number(d.pointBalance||0),pointStatus:d.pointStatus,pointWarning:d.pointWarning,dispatchable:!d.dispatchBlockReason,dispatchBlockReason:d.dispatchBlockReason,serviceCapabilities:normalizeCaps(d)}))});
    }catch(e){res.status(500).json({message:e.message});}
  });
  // Explicit write permission; viewers cannot dispatch orders.
  r.post('/orders/:id/dispatch',permit('orders.dispatch'),async(req,res)=>{
    try{
      const db=getDb(),_id=oid(req.params.id);if(!_id)return res.status(400).json({message:'Order ID không hợp lệ.'});
      const order=await db.collection('orders').findOne({_id});if(!order)return res.status(404).json({message:'Không tìm thấy đơn.'});
      if(req.body?.driverId){
        const updated=await assignCommerceDriver({db,order,driverId:req.body.driverId,notificationService:getNotifications?getNotifications():null,actorType:'ADMIN',actorId:req.admin._id});
        await db.collection('audit_logs').insertOne({actorType:'ADMIN',actorId:req.admin._id,action:'COMMERCE_ASSIGN_DRIVER',entityType:'ORDER',entityId:String(_id),after:{driverId:String(req.body.driverId)},createdAt:new Date()});
        return res.json({mode:'ASSIGNED',order:serialize(updated)});
      }
      const allowed=(['FOOD','ERRAND'].includes(order.serviceCode)&&order.status==='READY_FOR_PICKUP')||(order.serviceCode==='DELIVERY'&&order.status==='CREATED')||(order.serviceCode==='ERRAND'&&!order.merchantId&&order.status==='CREATED');
      if(!allowed)return res.status(409).json({message:`Đơn ${order.status} chưa sẵn sàng phát tài xế.`});
      const result=await dispatchCommerceReady({db,order,notificationService:getNotifications?getNotifications():null,actorType:'ADMIN',actorId:req.admin._id});
      await db.collection('audit_logs').insertOne({actorType:'ADMIN',actorId:req.admin._id,action:'COMMERCE_BROADCAST_DISPATCH',entityType:'ORDER',entityId:String(_id),after:{candidateCount:result.candidates.length},createdAt:new Date()});
      res.json({mode:'BROADCAST',candidateCount:result.candidates.length});
    }catch(e){res.status(400).json({message:e.message});}
  });
  return r;
}


function createCommerceDispatchWorker({getDb,getNotifications,intervalMs=10000}){
  let timer=null,busy=false;
  async function tick(){
    const db=getDb();if(!db||busy)return;busy=true;
    try{
      const cutoff=new Date(Date.now()-5000);
      const rows=await db.collection('orders').find({driverId:null,updatedAt:{$lte:cutoff},$or:[{serviceCode:'DELIVERY',status:'CREATED'},{serviceCode:'ERRAND',merchantId:null,status:'CREATED'},{serviceCode:{$in:['FOOD','ERRAND']},status:'READY_FOR_PICKUP'}]}).sort({updatedAt:1}).limit(20).toArray();
      for(const order of rows){
        // A dispatch attempt already notified drivers. Re-broadcast no more
        // than once per minute unless Admin explicitly retries this order.
        if(order.dispatchStartedAt && Date.now()-new Date(order.dispatchStartedAt).getTime()<60000) continue;
        await dispatchCommerceReady({db,order,notificationService:getNotifications?getNotifications():null,actorType:'SYSTEM'}).catch(()=>{});
      }
    }finally{busy=false;}
  }
  return {start(){if(timer)return;timer=setInterval(tick,Math.max(5000,Number(intervalMs)||10000));timer.unref?.();setTimeout(tick,1500);},close(){if(timer)clearInterval(timer);timer=null;}};
}

module.exports={createCommercePublicRouter,createMerchantRouter,createCommerceDriverRouter,createCommerceAdminRouter,createCommerceDispatchWorker,ensureCommerceIndexes,ORDER_STATUSES};
