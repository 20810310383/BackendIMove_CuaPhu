const test=require('node:test');const assert=require('node:assert/strict');
const {mergePermissions,SYSTEM_ROLES}=require('../src/system_roles');
test('merge adds canonical permissions and keeps custom ones',()=>{const result=mergePermissions(['drivers.view','custom.foo'],['drivers.view','trust.view']);assert.deepEqual(new Set(result),new Set(['drivers.view','custom.foo','trust.view']))});
test('operations role has trust.view',()=>assert.equal(SYSTEM_ROLES.OPERATIONS.permissions.includes('trust.view'),true));
