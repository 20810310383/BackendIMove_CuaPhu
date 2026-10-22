/** Merchant review is distinct from the day-to-day OPEN/BUSY/PAUSED status. */
const DOCUMENT_TYPES = Object.freeze(['ID_FRONT', 'STOREFRONT', 'BUSINESS_LICENSE']);
const REQUIRED_DOCUMENTS = Object.freeze(['ID_FRONT', 'STOREFRONT']);
function reviewStatus(merchant) {
  const explicit = String(merchant?.approvalStatus || '').toUpperCase();
  if (['PENDING','APPROVED','REJECTED'].includes(explicit)) return explicit;
  // Existing seeded/legacy active accounts were operational before review was introduced.
  const operational = String(merchant?.status || 'PENDING').toUpperCase();
  return operational === 'PENDING' ? 'PENDING' : operational === 'REJECTED' ? 'REJECTED' : 'APPROVED';
}
function missingReviewItems(merchant) {
  const missing = [];
  if (String(merchant?.name || '').trim().length < 2) missing.push('Tên cửa hàng');
  if (String(merchant?.phone || '').replace(/\s/g,'').length < 9) missing.push('Số điện thoại');
  if (String(merchant?.address || '').trim().length < 6) missing.push('Địa chỉ kinh doanh');
  for (const kind of REQUIRED_DOCUMENTS) {
    if (!merchant?.reviewDocuments?.[kind]?.filename) missing.push(kind === 'ID_FRONT' ? 'Ảnh CCCD/chứng minh chủ cửa hàng' : 'Ảnh mặt tiền cửa hàng');
  }
  return missing;
}
function reviewSummary(merchant) {
  const docs = {};
  for (const kind of DOCUMENT_TYPES) {
    const d = merchant?.reviewDocuments?.[kind];
    if (d?.filename) docs[kind] = {uploadedAt:d.uploadedAt,originalName:d.originalName,mime:d.mime,size:d.size};
  }
  return {approvalStatus:reviewStatus(merchant),reviewDocuments:docs,missingDocuments:missingReviewItems(merchant),reviewReason:merchant?.reviewReason||'',reviewedAt:merchant?.reviewedAt||null,reviewedBy:merchant?.reviewedBy||null};
}
module.exports = {DOCUMENT_TYPES,REQUIRED_DOCUMENTS,reviewStatus,missingReviewItems,reviewSummary};
