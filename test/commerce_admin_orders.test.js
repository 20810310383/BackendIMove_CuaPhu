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

function commerceCandidatesHandler(db) {
  const router = createCommerceAdminRouter({ getDb: () => db });
  const layer = router.stack.find((item) => item.route?.path === '/orders/:id/candidates' && item.route.methods.get);
  return layer.route.stack.at(-1).handle;
}

test('commerce admin feed only queries commerce services and clamps the result size', async () => {
  let query;
  let options;
  let limit;
  let skip;
  const db = {
    collection() {
      return {
        find(nextQuery, nextOptions) {
          query = nextQuery;
          options = nextOptions;
          return {
            sort() {
              return {
                skip(nextSkip) {
                  skip = nextSkip;
                  return this;
                },
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
  assert.equal(skip, 0);
  assert.equal(limit, 201);
  assert.equal(res.code, 200);
  assert.equal(res.body.limit, 200);
  assert.equal(res.body.page, 1);
});

test('commerce admin feed rejects a non-commerce service before querying MongoDB', async () => {
  const res = response();
  await adminOrdersHandler({ collection() { throw new Error('MongoDB must not be queried'); } })({ query: { serviceCode: 'BIKE' } }, res);
  assert.equal(res.code, 400);
  assert.match(res.body.message, /commerce không hợp lệ/);
});

test('commerce admin feed defaults to 20 rows for the first operations page', async () => {
  let limit;
  const db = {
    collection() {
      return {
        find() {
          return { sort() { return { skip() { return this; }, limit(nextLimit) { limit = nextLimit; return { toArray: async () => [] }; } }; } };
        },
      };
    },
  };

  const res = response();
  await adminOrdersHandler(db)({ query: {} }, res);
  assert.equal(limit, 21);
  assert.equal(res.body.limit, 20);
  assert.equal(res.body.page, 1);
  assert.equal(res.body.hasNext, false);
});

test('commerce admin feed skips prior pages and signals a next page without a full count', async () => {
  let skip;
  let limit;
  const rows=Array.from({length:21},(_,index)=>({_id:`order-${index}`,serviceCode:'FOOD'}));
  const db={collection(){return {find(){return {sort(){return {skip(nextSkip){skip=nextSkip;return this;},limit(nextLimit){limit=nextLimit;return {toArray:async()=>rows};}};}};}};}};

  const res=response();
  await adminOrdersHandler(db)({query:{page:'3',limit:'20'}},res);

  assert.equal(skip,40);
  assert.equal(limit,21);
  assert.equal(res.body.page,3);
  assert.equal(res.body.hasPrevious,true);
  assert.equal(res.body.hasNext,true);
  assert.equal(res.body.orders.length,20);
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

test('manual commerce dispatch returns a newly registered driver with their unavailable reason', async () => {
  const orderId = '507f1f77bcf86cd799439011';
  const cursor = (rows) => ({
    sort() { return this; },
    limit() { return { toArray: async () => rows }; },
    project() { return { toArray: async () => rows }; },
  });
  const db = {
    collection(name) {
      if (name === 'orders') return { findOne: async () => ({ _id: orderId, serviceCode: 'FOOD' }) };
      if (name === 'drivers') {
        return {
          find(query) {
            assert.deepEqual(query, {});
            return cursor([{
              _id: 'registered-driver',
              userId: 'registered-user',
              approvalStatus: 'PENDING',
              kycStatus: 'INCOMPLETE',
              onlineStatus: 'OFFLINE',
              requestedServiceCodes: ['FOOD'],
            }]);
          },
        };
      }
      if (name === 'users') return { find: () => cursor([{ _id: 'registered-user', fullName: 'Tài xế mới', phone: '0901000000' }]) };
      if (name === 'driver_reward_accounts') return { find: () => cursor([]) };
      if (name === 'matching_policies') return { findOne: async () => null };
      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  const res = response();
  await commerceCandidatesHandler(db)({ params: { id: orderId } }, res);

  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.drivers.length, 1);
  assert.equal(res.body.drivers[0].fullName, 'Tài xế mới');
  assert.equal(res.body.drivers[0].phone, '0901000000');
  assert.equal(res.body.drivers[0].dispatchable, false);
  assert.match(res.body.drivers[0].dispatchBlockReason, /chưa được duyệt/i);
});
