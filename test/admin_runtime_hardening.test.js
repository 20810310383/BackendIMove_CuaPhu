const test = require('node:test');
const assert = require('node:assert/strict');
const { after } = require('node:test');
const jwt = require('jsonwebtoken');
const { createAdminGuard } = require('../src/admin_guard');
const { ensureFundTopupIndexes } = require('../src/fund_topup_routes');

const previousSecret = process.env.JWT_ACCESS_SECRET;
process.env.JWT_ACCESS_SECRET = 'test-only-admin-secret-that-is-long-enough-123456';
after(() => {
  if (previousSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
  else process.env.JWT_ACCESS_SECRET = previousSecret;
});

function runGuard(guard, token) {
  return new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; resolve({ req, res: this, next: false }); },
    };
    guard(req, res, () => resolve({ req, res, next: true }));
  });
}

test('admin guard coalesces concurrent role checks for the same access token', async () => {
  let userReads = 0;
  let roleReads = 0;
  const db = {
    collection(name) {
      if (name === 'users') return {
        findOne: async () => {
          userReads += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { _id: '507f1f77bcf86cd799439011', roles: ['ADMIN'], adminRoleCodes: ['OPS'] };
        },
      };
      if (name === 'admin_roles') return {
        find: () => ({ toArray: async () => { roleReads += 1; return [{ permissions: ['settings.view'] }]; } }),
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };
  const token = jwt.sign({}, process.env.JWT_ACCESS_SECRET, { subject: '507f1f77bcf86cd799439011' });
  const guard = createAdminGuard({ getDb: () => db }).requireAdmin;

  const [first, second] = await Promise.all([runGuard(guard, token), runGuard(guard, token)]);

  assert.equal(first.next, true);
  assert.equal(second.next, true);
  assert.equal(userReads, 1);
  assert.equal(roleReads, 1);
  assert.deepEqual(first.req.adminPermissions, ['settings.view']);
});

test('admin guard reports a temporary MongoDB failure as 503, not an invalid session', async () => {
  const db = {
    collection() {
      return { findOne: async () => { throw new Error('MongoServerSelectionError: connection timed out'); } };
    },
  };
  const token = jwt.sign({}, process.env.JWT_ACCESS_SECRET, { subject: '507f1f77bcf86cd799439012' });
  const result = await runGuard(createAdminGuard({ getDb: () => db }).requireAdmin, token);

  assert.equal(result.next, false);
  assert.equal(result.res.statusCode, 503);
  assert.equal(result.res.payload.code, 'DATABASE_UNAVAILABLE');
});

test('fund top-up indexes cover the admin request filters', async () => {
  const calls = [];
  await ensureFundTopupIndexes({
    collection(name) {
      assert.equal(name, 'fund_topup_requests');
      return { createIndex: async (keys, options) => calls.push({ keys, options }) };
    },
  });

  assert.deepEqual(calls.map((call) => call.options.name), [
    'idx_fund_topups_recent',
    'idx_fund_topups_status_recent',
    'idx_fund_topups_actor_status_recent',
    'idx_fund_topups_owner_recent',
  ]);
});
