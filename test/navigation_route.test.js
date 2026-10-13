const test=require('node:test');const assert=require('node:assert/strict');
const {normalizeRoute}=require('../src/map_service');
test('normalizeRoute returns maneuver steps',()=>{const r=normalizeRoute({routes:[{distance:1000,duration:180,geometry:{coordinates:[[106.7,10.7],[106.71,10.71]]},legs:[{steps:[{distance:250,duration:50,name:'Nguyễn Văn Linh',maneuver:{type:'turn',modifier:'right',location:[106.705,10.705]}}]}]}]});assert.equal(r.steps.length,1);assert.equal(r.steps[0].type,'turn');assert.equal(r.steps[0].modifier,'right');assert.equal(r.steps[0].roadName,'Nguyễn Văn Linh')});
