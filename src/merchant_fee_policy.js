'use strict';
// Source of truth for Merchant fees. Both preview and order snapshot call this module.
const CONFIG_ID = 'MERCHANT_FEE_RULES_V1';
const MAX_RULES = 30;
function fail(message) { const error = new Error(message); error.statusCode = 400; throw error; }
function intVnd(input, label='Số tiền') {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000000000) fail(`${label} phải là số nguyên VND từ 0 đến 1 tỷ.`);
  return value;
}
function normalizeRules(input) {
  if (!Array.isArray(input) || input.length > MAX_RULES) fail('Danh sách phí tối đa 30 khoản.');
  const seen = new Set();
  return input.map((row, i) => {
    const id = String(row?.id || '').trim();
    const name = String(row?.name || '').trim();
    const method = String(row?.method || '').toUpperCase();
    const merchantId = String(row?.merchantId || '').trim();
    const value = Number(row?.value);
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(id) || seen.has(id)) fail(`Mã phí dòng ${i+1} không hợp lệ hoặc trùng.`);
    seen.add(id);
    if (!name || name.length > 90) fail(`Tên phí dòng ${i+1} phải có 1–90 ký tự.`);
    if (!['PERCENT','FIXED'].includes(method)) fail(`Kiểu phí dòng ${i+1} không hợp lệ.`);
    if (!Number.isFinite(value) || value < 0 || (method === 'PERCENT' ? value > 100 || Math.abs(Math.round(value * 100) - value * 100) > 0.000001 : !Number.isSafeInteger(value) || value > 100000000)) fail(`Mức phí dòng ${i+1} không hợp lệ.`);
    if (merchantId && !/^[a-f0-9]{24}$/i.test(merchantId)) fail(`Merchant ID dòng ${i+1} không hợp lệ.`);
    return { id, name, method, value, merchantId: merchantId || null, enabled: row?.enabled !== false };
  });
}
async function loadMerchantFees(db) {
  const doc = await db.collection('commerce_settings').findOne({ _id: CONFIG_ID });
  return { revision: Number(doc?.revision || 0), updatedAt: doc?.updatedAt || null, rules: normalizeRules(doc?.rules || []) };
}
function calculateMerchantFees({ subtotal, merchantId, config }) {
  const grossAmount = intVnd(subtotal, 'Tiền hàng');
  let remaining = grossAmount;
  const rules = (config?.rules || []).filter(r => r.enabled && (!r.merchantId || String(r.merchantId) === String(merchantId)));
  const fees = rules.map(rule => {
    const calculatedAmount = rule.method === 'PERCENT' ? Math.round(grossAmount * rule.value / 100) : Math.round(rule.value);
    const amount = Math.min(calculatedAmount, remaining);
    remaining -= amount;
    return { id: rule.id, name: rule.name, method: rule.method, value: rule.value, baseAmount: grossAmount, calculatedAmount, amount, capped: amount !== calculatedAmount };
  });
  return {
    revision: Number(config?.revision || 0),
    calculatedAt: new Date().toISOString(),
    grossAmount, fees, feeTotal: grossAmount - remaining, netAmount: remaining,
    hasCappedFees: fees.some(f => f.capped),
    note: 'Dự tính trên tiền hàng, chưa bao gồm hoàn tiền/khuyến mãi, thuế hoặc các điều chỉnh sau giao dịch.'
  };
}
module.exports = { CONFIG_ID, intVnd, normalizeRules, loadMerchantFees, calculateMerchantFees };
