const test=require('node:test');const assert=require('node:assert/strict');
const {calculatePromotionDiscount,normalizePromotionCode}=require('../src/promotion_service');
test('percent promotion respects cap',()=>assert.equal(calculatePromotionDiscount({discountType:'PERCENT',discountValue:20,maxDiscount:30000},200000),30000));
test('fixed promotion never exceeds fare',()=>assert.equal(calculatePromotionDiscount({discountType:'FIXED',discountValue:50000},30000),30000));
test('promotion code is canonical',()=>assert.equal(normalizePromotionCode(' th79new '),'TH79NEW'));

test('new-customer-only promotion rejects users with completed trips',()=>{
  const {isNewCustomerEligible}=require('../src/promotion_service');
  assert.equal(isNewCustomerEligible({newCustomerOnly:true},0),true);
  assert.equal(isNewCustomerEligible({newCustomerOnly:true},1),false);
  assert.equal(isNewCustomerEligible({newCustomerOnly:false},99),true);
});
