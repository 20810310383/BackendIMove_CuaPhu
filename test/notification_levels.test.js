const test=require('node:test');const assert=require('node:assert/strict');
const {normalizeNotificationLevel}=require('../src/notification_service');
test('notification levels preserve 1..4',()=>{for(const n of [1,2,3,4])assert.equal(normalizeNotificationLevel(n),n);assert.equal(normalizeNotificationLevel(99),4);assert.equal(normalizeNotificationLevel(null),4)});
