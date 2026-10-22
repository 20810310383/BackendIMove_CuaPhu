'use strict';

const ACCEPTED_STATES = new Set(['PENDING_REVIEW', 'APPROVED', 'REJECTED']);
const ACTIVE_STATES = new Set(['ACTIVE', 'OPEN', 'BUSY', 'PAUSED']);

// Legacy merchants that were already active before an independent review status was
// introduced keep functioning; new PENDING stores NEVER inherit this exception.
function effectiveApproval(merchant) {
  const explicit = String(merchant?.approvalStatus || '').toUpperCase();
  if (ACCEPTED_STATES.has(explicit)) return explicit;
  if (explicit === 'PENDING') return 'PENDING_REVIEW';
  const status = String(merchant?.status || '').toUpperCase();
  return ACTIVE_STATES.has(status) ? 'APPROVED' : 'PENDING_REVIEW';
}

function isMerchantApproved(merchant) {
  return effectiveApproval(merchant) === 'APPROVED';
}

// Query-compatible with old data; do not require an immediate DB migration.
function approvedMerchantQuery() {
  return { $or: [
    { approvalStatus: 'APPROVED' },
    { approvalStatus: { $exists: false }, status: { $in: [...ACTIVE_STATES] } },
    { approvalStatus: null, status: { $in: [...ACTIVE_STATES] } },
  ] };
}

module.exports = { effectiveApproval, isMerchantApproved, approvedMerchantQuery };
