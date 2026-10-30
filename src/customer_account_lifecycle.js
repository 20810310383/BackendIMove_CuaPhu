'use strict';

// Customer account lifecycle: do not reuse a MongoDB _id or transfer any
// booking, order, loyalty, wallet or referral history to another account.
const crypto = require('crypto');
const { ObjectId } = require('mongodb');

const CLOSED_NAME = 'Tài khoản đã xóa';
const FINAL_BOOKING = ['COMPLETED','CANCELLED','CANCELLED_BY_USER','CANCELLED_BY_DRIVER','EXPIRED','FAILED'];
const FINAL_ORDER = ['COMPLETED','CANCELLED','REJECTED','REFUNDED'];
const PENDING_PAYMENT = ['PENDING','PROCESSING','REFUND_PENDING','REFUND_REQUESTED','UNSETTLED'];
const normalizePhone = phone => String(phone || '').replace(/\D/g, '');
const deletedPhonePlaceholder = id => `DELETED_${String(id)}`;

function deletedPhoneHash(phone) {
  // Deterministic but nonreversible without server-side secret.
  // Deliberately *not* used to identify/restore a previous user.
  const secret = String(process.env.ACCOUNT_DELETION_HMAC_KEY || process.env.JWT_ACCESS_SECRET || '');
  if (secret.length < 32) throw Object.assign(new Error('Cần cấu hình ACCOUNT_DELETION_HMAC_KEY hoặc JWT_ACCESS_SECRET >= 32 ký tự.'), { status:503 });
  return crypto.createHmac('sha256', secret).update(`CUSTOMER:${normalizePhone(phone)}`).digest('hex');
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
function idAlternatives(id) { return [id, String(id)]; }

async function verifyCustomerMayClose(db, existing) {
  if (!Array.isArray(existing.roles) || !existing.roles.includes('CUSTOMER') || existing.roles.some(x => x !== 'CUSTOMER')) {
    throw httpError(409,'MULTI_ROLE_ACCOUNT','Tài khoản còn vai trò khác. Không thể xóa tự động qua mục Khách hàng.');
  }
  if (String(existing.status || '').toUpperCase() === 'BLOCKED') {
    throw httpError(409,'ACCOUNT_BLOCKED','Tài khoản bị khóa phải xử lý theo quy trình quản trị riêng, không xóa để vượt khóa.');
  }
  const refs = idAlternatives(existing._id);
  const bookings = await db.collection('bookings').countDocuments({
    customerId: { $in: refs }, status: { $nin: FINAL_BOOKING }
  }, { limit: 1 });
  if (bookings) throw httpError(409,'ACTIVE_BOOKING','Còn chuyến chưa kết thúc. Hãy hoàn tất hoặc hủy chuyến trước khi xóa tài khoản.');
  const orders = await db.collection('orders').countDocuments({
    customerId: { $in: refs }, status: { $nin: FINAL_ORDER }
  }, { limit: 1 });
  if (orders) throw httpError(409,'ACTIVE_ORDER','Còn đơn FOOD/GIAO HÀNG/MUA HỘ chưa kết thúc.');
  const wallet = await db.collection('wallets').findOne({ userId: { $in: refs } });
  if (wallet && (Number(wallet.balance || 0) > 0 || Number(wallet.availableBalance || 0) > 0 || Number(wallet.lockedBalance || 0) > 0)) {
    throw httpError(409,'UNSETTLED_WALLET','Ví còn tiền hoặc số dư bị giữ. Hãy xử lý hoàn tiền/đối soát trước khi xóa.');
  }
  const payments = await db.collection('payments').countDocuments({
    $or: [{ userId: { $in: refs } }, { customerId: { $in: refs } }],
    status: { $in: PENDING_PAYMENT }
  }, { limit: 1 });
  if (payments) throw httpError(409,'PENDING_PAYMENT','Còn giao dịch thanh toán hoặc hoàn tiền đang xử lý.');
}

async function disableCustomerAccess(db, userId, timestamp) {
  // A deleted account must not keep session or registered push device tokens.
  await db.collection('auth_sessions').updateMany({ userId: { $in: idAlternatives(userId) }, revokedAt: null }, {
    $set: { revokedAt: timestamp, revokeReason: 'CUSTOMER_DELETED', updatedAt: timestamp }
  });
  await db.collection('device_tokens').updateMany({ userId: { $in: idAlternatives(userId) } }, {
    $set: { enabled: false, updatedAt: timestamp }
  });
}

async function retireCustomerReferralCodes(db, userId, oldPhone, timestamp) {
  const codes = await db.collection('referral_codes').find({ ownerUserId: { $in: idAlternatives(userId) } }).toArray();
  for (const item of codes) {
    // Free phone-based code, while preserving the historical referralCodeId.
    const retireCode = String(item.code || '') === oldPhone || /^0\d{9}$/.test(String(item.code || ''));
    await db.collection('referral_codes').updateOne({ _id: item._id }, {
      $set: {
        status: 'DISABLED', updatedAt: timestamp,
        ...(retireCode ? { code: `ARCH${String(item._id).slice(0,16)}` } : {})
      },
      $unset: { ownerPhone: '', ownerName: '' }
    });
  }
}

async function softDeleteCustomer(db, existing, opts = {}) {
  const id = existing?._id;
  if (!(id instanceof ObjectId)) throw httpError(400,'INVALID_ID','ID khách hàng không hợp lệ.');
  if (!Array.isArray(existing.roles) || existing.roles.some(role => role !== 'CUSTOMER')) {
    throw httpError(409,'MULTI_ROLE_ACCOUNT','Không thể xóa tài khoản có nhiều vai trò qua luồng Customer.');
  }
  const users = db.collection('users');
  const timestamp = new Date();
  const alreadyDeleted = String(existing.status || '').toUpperCase() === 'DELETED';
  if (!alreadyDeleted) await verifyCustomerMayClose(db, existing);
  const oldPhone = normalizePhone(existing.phone);
  const phoneWasLive = /^0\d{9}$/.test(oldPhone);
  const update = {
    $set: {
      status: 'DELETED', fullName: CLOSED_NAME,
      phone: deletedPhonePlaceholder(id),
      updatedAt: timestamp,
      deletedAt: existing.deletedAt || timestamp,
      deletionReason: String(opts.reason || existing.deletionReason || 'ADMIN_REQUEST').slice(0,160),
      ...(phoneWasLive ? { deletedPhoneHash: deletedPhoneHash(oldPhone) } : {}),
    },
    $unset: { email: '', avatarUrl: '', avatarFileId: '', passwordHash: '', lastLoginAt: '', refreshToken: '', resetToken: '', savedAddresses: '', paymentMethods: '', dateOfBirth: '', identityNumber: '' }
  };
  const changed = await users.updateOne({
    _id: id, roles: 'CUSTOMER',
    status: alreadyDeleted ? 'DELETED' : { $ne: 'DELETED' },
    ...(existing.phone ? { phone: existing.phone } : {})
  }, update);
  if (!changed.matchedCount) throw httpError(409,'ACCOUNT_STATE_CHANGED','Tài khoản đã thay đổi. Hãy tải lại và thử thao tác.');

  // Kept separate so a retry on DELETED can complete token cleanup after a
  // transient notification or database failure; never resurrect the account.
  await disableCustomerAccess(db, id, timestamp);
  await retireCustomerReferralCodes(db, id, oldPhone, timestamp);
  return { ok: true, status: 'DELETED', userId: String(id), canRegisterAgain: true };
}

// One-time compatibility with older Admin versions that only set status=DELETED.
async function releaseLegacyDeletedPhone(db, phone) {
  const account = await db.collection('users').findOne({ phone, status: 'DELETED', roles: 'CUSTOMER' });
  if (!account) return false;
  await softDeleteCustomer(db, account, { reason: 'LEGACY_SOFT_DELETE_MIGRATION' });
  return true;
}

module.exports = {
  deletedPhoneHash, deletedPhonePlaceholder, softDeleteCustomer,
  releaseLegacyDeletedPhone, verifyCustomerMayClose, httpError
};
