const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
test('serialized booking exposes serviceCode for customer and driver apps',()=>{const start=source.indexOf('function serializeBooking');const end=source.indexOf('async function addEvent',start);const block=source.slice(start,end);assert.match(block,/serviceCode:/);});
