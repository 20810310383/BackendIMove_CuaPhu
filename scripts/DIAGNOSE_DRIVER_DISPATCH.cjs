/** Read-only matching check for ONE driver/user id. NO updates and NO sensitive IDs beyond inputs. */
'use strict';
const path=require('path');
try { require('dotenv').config({path:path.join(process.cwd(),'.env'),quiet:true}); } catch (_) {}
const { MongoClient, ObjectId }=require('mongodb');
const asOid=s=>{try{return new ObjectId(String(s));}catch{return null;}};
const asIdArray=x=>[x,asOid(x)].filter(Boolean);
const asCodes=x=>Array.isArray(x)?x.map(v=>String(v||'').toUpperCase()):[];
function haversineKm(a,b){const rad=x=>x*Math.PI/180;const dlat=rad(a[1]-b[1]);const dlon=rad(a[0]-b[0]);const q=Math.sin(dlat/2)**2+Math.cos(rad(a[1]))*Math.cos(rad(b[1]))*Math.sin(dlon/2)**2;return 6371*2*Math.atan2(Math.sqrt(q),Math.sqrt(1-q));}
const print=(name,value)=>console.log(`${name}: ${typeof value==='object'?JSON.stringify(value):value}`);
async function main(){
 const input=process.argv[2]; const bookingInput=process.argv[3];
 if(!input||!asOid(input)){console.error('Usage: node scripts/DIAGNOSE_DRIVER_DISPATCH.cjs <DRIVER_OR_USER_ID> [BOOKING_ID]');process.exitCode=2;return;}
 const uri=String(process.env.MONGODB_URI||'').trim();
 if(!uri){console.error('Missing MONGODB_URI. Run from backend with authorized environment; NEVER share .env.');process.exitCode=2;return;}
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:8000});
 try {
 await client.connect(); const db=client.db(process.env.MONGODB_DB||'th79_imove');
 const inputId=asOid(input);
 let driver=await db.collection('drivers').findOne({_id:inputId});
 if(!driver) driver=await db.collection('drivers').findOne({userId:{$in:asIdArray(input)}});
 if(!driver){print('RESULT','NO_DRIVER_RECORD_MATCHES_ID');return;}
 const did=driver._id;const uid=driver.userId;
 const user=uid?await db.collection('users').findOne({_id:{$in:asIdArray(uid)}}):null;
 const vehicles=await db.collection('vehicles').find({driverId:{$in:asIdArray(did)}}).project({status:1,serviceCode:1,serviceCodes:1,approvedServiceCodes:1,verificationStatus:1,vehicleType:1}).toArray();
 const loc=await db.collection('driver_locations').findOne({driverId:{$in:asIdArray(did)}});
 const now=new Date();const locAge=loc?.updatedAt?Math.max(0,Math.round((Date.now()-new Date(loc.updatedAt).getTime())/1000)):null;
 const bookings=await db.collection('bookings').find({driverId:{$in:asIdArray(did)},status:{$in:['DRIVER_ASSIGNED','DRIVER_ARRIVING','DRIVER_ARRIVED','IN_PROGRESS']}}).project({_id:1,status:1}).limit(10).toArray();
 const offers=await db.collection('booking_offers_v69').countDocuments({driverId:{$in:asIdArray(did)},status:'PENDING',expiresAt:{$gt:now}});
 const cooldowns=await db.collection('driver_cooldowns').find({driverId:{$in:asIdArray(did)},expiresAt:{$gt:now}}).project({type:1,expiresAt:1}).limit(10).toArray();
 const points=await db.collection('driver_reward_accounts').findOne({driverId:{$in:asIdArray(did)}},{projection:{balance:1}});
 const policy=await db.collection('matching_policies').findOne({key:'BIKE_MATCHING_POLICY'});
 const cfg=await db.collection('dispatch_configs').findOne({key:'BIKE_V69_DISPATCH'});
 let bk=null;if(bookingInput&&asOid(bookingInput))bk=await db.collection('bookings').findOne({_id:asOid(bookingInput)});
 const service=String(bk?.serviceCode||'').toUpperCase();
 const approvedDriver=asCodes(driver.approvedServiceCodes);
 const gpsFreshSeconds=Number(policy?.locationFreshSeconds??process.env.MATCHING_LOCATION_FRESH_SECONDS??45);
 const fallbackEnabled=policy?.allowNoGpsFallback===true || (policy?.allowNoGpsFallback==null && process.env.MATCHING_ALLOW_NO_GPS_FALLBACK!=='false');
 const reasons=[];
 if(String(driver.approvalStatus)!=='APPROVED')reasons.push('DRIVER_APPROVAL_NOT_APPROVED');
 if(String(driver.kycStatus)!=='APPROVED')reasons.push('DRIVER_KYC_NOT_APPROVED');
 if(String(driver.onlineStatus)!=='ONLINE')reasons.push('DRIVER_NOT_ONLINE');
 if(!user)reasons.push('LINKED_USER_MISSING_OR_WRONG_TYPE');
 if(!vehicles.some(v=>v.status==='APPROVED'))reasons.push('NO_APPROVED_VEHICLE');
 if(!loc)reasons.push('NO_GPS_LOCATION_RECORD');
 else if(locAge>gpsFreshSeconds)reasons.push('GPS_STALE');
 if(bookings.length)reasons.push('DRIVER_HAS_ACTIVE_BOOKING');
 if(offers>0)reasons.push('DRIVER_HAS_PENDING_OFFER');
 if(cooldowns.length)reasons.push('DRIVER_COOLDOWN_ACTIVE');
 if(cfg?.enabled===false)reasons.push('V69_DISPATCH_DISABLED');
 if(policy?.autoDispatchEnabled===false)reasons.push('MATCHING_POLICY_DISABLED');
 if(service){
  if(approvedDriver.length&&!approvedDriver.includes(service))reasons.push('DRIVER_SERVICE_NOT_APPROVED_FOR_BOOKING');
  if(driver.servicePreferences?.[service]===false)reasons.push('DRIVER_SERVICE_DISABLED_IN_PREFERENCES');
  if(!vehicles.some(v=>v.status==='APPROVED'&&[...asCodes(v.approvedServiceCodes),...asCodes(v.serviceCodes),String(v.serviceCode||'').toUpperCase()].includes(service)))reasons.push('VEHICLE_SERVICE_NOT_MATCHING');
 }
 print('INPUT_ID',input);print('RESOLVED_DRIVER_ID',String(did));print('INPUT_WAS_USER_ID',String(did)!==String(input));
 print('DRIVER_STATUS',{approvalStatus:driver.approvalStatus||null,kycStatus:driver.kycStatus||null,onlineStatus:driver.onlineStatus||null,approvedServiceCodes:approvedDriver,servicePreferences:driver.servicePreferences||{},activeBookingId:driver.activeBookingId?String(driver.activeBookingId):null});
 print('VEHICLES',vehicles.map(v=>({id:String(v._id),status:v.status,verificationStatus:v.verificationStatus,vehicleType:v.vehicleType,serviceCode:v.serviceCode,serviceCodes:v.serviceCodes,approvedServiceCodes:v.approvedServiceCodes})));
 print('GPS',{exists:Boolean(loc),ageSeconds:locAge,locationFreshSeconds:gpsFreshSeconds,validCoordinates:Array.isArray(loc?.location?.coordinates)&&loc.location.coordinates.length===2});
 print('POINT_BALANCE',points?.balance??null);
 print('MATCHING',{autoDispatchEnabled:policy?.autoDispatchEnabled??null,allowNoGpsFallback:fallbackEnabled,dispatchEnabled:cfg?.enabled??null});
 print('ACTIVE_BOOKING_COUNT',bookings.length);print('PENDING_OFFER_COUNT',offers);print('ACTIVE_COOLDOWN_TYPES',cooldowns.map(v=>v.type));
 if(bk){
  const pickup=bk?.pickup?.location?.coordinates,coords=loc?.location?.coordinates;
  const distance=Array.isArray(pickup)&&Array.isArray(coords)&&pickup.length===2&&coords.length===2 ? haversineKm(coords,pickup):null;
  const maxRadius=Number(policy?.maxRadiusKm||12);
  if(distance!==null&&distance>maxRadius)reasons.push('OUTSIDE_MATCHING_RADIUS');
  print('BOOKING',{id:bookingInput,status:bk.status,serviceCode:service,pickupGpsValid:Array.isArray(pickup),distanceKm:distance==null?null:Number(distance.toFixed(2)),maxRadiusKm:maxRadius});
 }
 print('POSSIBLE_BLOCKERS',reasons);print('NOTE','Read-only observations, not proof of the exact previous offer decision. Compare dispatch_events and booking_offers_v69 for one failed booking.');
 } finally{await client.close();}
}
main().catch(e=>{console.error(`DIAGNOSIS_FAILED: ${e.message}`);process.exitCode=1;});
