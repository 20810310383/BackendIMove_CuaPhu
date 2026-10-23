'use strict';
const assert = require('node:assert/strict');
const { createWebTestCorsController, isLoopbackWebOrigin } = require('../src/web_test_cors');
async function main() {
  let current = new Date('2026-10-23T04:00:00.000Z');
  const docs = new Map();
  const audits = [];
  const db = { collection(name) { return {
    async findOne(filter) { return docs.get(`${name}/${filter._id}`) || null; },
    async updateOne(filter, update) { docs.set(`${name}/${filter._id}`, { _id:filter._id, ...update.$set }); },
    async insertOne(data) { if(name==='audit_logs') audits.push(data); },
  }; } };
  const controller = createWebTestCorsController({getDb:()=>db, clock:()=>current});
  const test = async (label, action) => { await action(); console.log('OK',label); };
  await test('mặc định tắt', async()=>assert.equal((await controller.status()).enabled,false));
  await test('không tự cấp CORS trước khi bật', async()=>assert.equal(await controller.isAllowedOrigin('http://localhost:53549'),false));
  await test('cho phép bật 30 phút', async()=>assert.equal((await controller.update({enabled:true,minutes:30,actorId:'admin'})).enabled,true));
  await test('localhost hợp lệ', async()=>assert.equal(await controller.isAllowedOrigin('http://localhost:53549'),true));
  await test('127.0.0.1 hợp lệ', async()=>assert.equal(await controller.isAllowedOrigin('http://127.0.0.1:12345'),true));
  await test('origin bên ngoài bị chặn', async()=>assert.equal(await controller.isAllowedOrigin('https://evil.com'),false));
  await test('localhost giả mạo bị chặn', async()=>assert.equal(isLoopbackWebOrigin('http://localhost.evil.com:53549'),false));
  await test('cổng <1024 bị chặn', async()=>assert.equal(isLoopbackWebOrigin('http://localhost:80'),false));
  current=new Date(current.getTime()+31*60000);
  await test('hết hạn tự tắt', async()=>assert.equal(await controller.isAllowedOrigin('http://localhost:53549'),false));
  await test('bật lại rồi tắt thủ công', async()=>{
    await controller.update({enabled:true,minutes:60});
    assert.equal((await controller.update({enabled:false})).enabled,false);
  });
  await test('audit log tồn tại', async()=>assert.ok(audits.length>=3));
  console.log('11/11 test controller passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
