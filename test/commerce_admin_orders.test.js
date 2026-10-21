const test = require('node:test');
const assert = require('node:assert/strict');
const { createCommerceAdminRouter, ensureCommerceIndexes } = require('../src/commerce_routes');

function response() {
  return {
    code: 200,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function adminOrdersHandler(db) {
  const router = createCommerceAdminRouter({ getDb: () => db });
  const layer = router.stack.find((item) => item.route?.path === '/orders' && item.route.methods.get);
  return layer.route.stack.at(-1).handle;
}

test('commerce admin feed only queries commerce services and clamps the result size', async () => {
  let query;
  let options;
  let limit;
  const db = {
    collection() {
      return {
        find(nextQuery, nextOptions) {
          query = nextQuery;
          options = nextOptions;
          return {
            sort() {
              return {
                limit(nextLimit) {
                  limit = nextLimit;
                  return { toArray: async () => [{ _id: 'order-1', serviceCode: 'FOOD' }] };
                },
              };
            },
          };
        },
      };
    },
  };

  const res = response();
  await adminOrdersHandler(db)({ query: { serviceCode: 'food', status: 'created', limit: '999' } }, res);

  assert.equal(query.serviceCode, 'FOOD');
  assert.equal(query.status, 'CREATED');
  assert.equal(options.maxTimeMS, 12000);
  assert.equal(limit, 200);
  assert.equal(res.code, 200);
  assert.equal(res.body.limit, 200);
});

test('commerce admin feed rejects a non-commerce service before querying MongoDB', async () => {
  const res = response();
  await adminOrdersHandler({ collection() { throw new Error('MongoDB must not be queried'); } })({ query: { serviceCode: 'BIKE' } }, res);
  assert.equal(res.code, 400);
  assert.match(res.body.message, /commerce không hợp lệ/);
});

test('commerce indexes cover recent and status-filtered order feeds', async () => {
  const calls = [];
  await ensureCommerceIndexes({
    collection(name) {
      assert.equal(name, 'orders');
      return { createIndex: async (keys, options) => calls.push({ keys, options }) };
    },
  });

  assert.deepEqual(calls.map((call) => call.options.name), [
    'idx_commerce_orders_recent',
    'idx_commerce_orders_service_status_recent',
  ]);
});
