const routes = require('../src/driver_experience_routes');
const points = require('../src/driver_points_service');

const expectedRoutes = [
  'createDriverExperienceRouter',
  'createDriverExperienceAdminRouter',
  'createDriverPointBankWebhookRouter',
];
const expectedPoints = [
  'createTopupRequest',
  'approveTopupRequest',
  'confirmTopupByBankTransfer',
  'rejectTopupRequest',
];

let ok = true;
for (const name of expectedRoutes) {
  const type = typeof routes[name];
  console.log(`[driver_experience_routes] ${name}: ${type}`);
  if (type !== 'function') ok = false;
}
for (const name of expectedPoints) {
  const type = typeof points[name];
  console.log(`[driver_points_service] ${name}: ${type}`);
  if (type !== 'function') ok = false;
}

if (!ok) {
  console.error('FAILED: Driver point module exports are inconsistent.');
  process.exit(1);
}
console.log('OK: Driver point/webhook exports are aligned.');
