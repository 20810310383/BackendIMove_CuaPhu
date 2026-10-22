// Prices must be computed from routing metrics obtained by the server.
// Client distanceKm/durationMinutes are advisory only, never authoritative.
'use strict';
const { createMapService, assertLatLon } = require('./map_service');
const mapService = createMapService();
function extractLocation(value) {
  if(!value || typeof value!=='object')throw Object.assign(new Error('Thiếu tọa độ điểm đón/đến.'),{httpStatus:400});
  const geometry=value.location?.coordinates || value.coordinates;
  const latitude = geometry ? geometry[1] : value.latitude;
  const longitude = geometry ? geometry[0] : value.longitude;
  try {
    const result=assertLatLon(latitude,longitude);
    // Null Island / zero coordinates from invalid GPS readings cannot be billed.
    if(Math.abs(result.latitude)<0.0001 && Math.abs(result.longitude)<0.0001)throw new Error('Tọa độ 0,0 không hợp lệ.');
    return result;
  }catch(_){throw Object.assign(new Error('Tọa độ điểm đón/đến không hợp lệ.'),{httpStatus:400});}
}
async function verifiedMetrics({pickup,destination,vehicleType='MOTORBIKE',routeService=mapService}) {
  const a=extractLocation(pickup), b=extractLocation(destination);
  let route;
  try {
    route=await routeService.route(a.latitude,a.longitude,b.latitude,b.longitude,{vehicleType});
  }catch(err){throw Object.assign(new Error('Dịch vụ tính tuyến đường đang lỗi. Vui lòng thử lại sau.'),{httpStatus:503,code:'TRUSTED_ROUTE_UNAVAILABLE'});}
  if(route.isFallback || !Number.isFinite(route.distanceMeters) || !Number.isFinite(route.durationSeconds) || route.distanceMeters<=0 || route.durationSeconds<=0)
    throw Object.assign(new Error('Không thể xác minh cước với tuyến đường hiện tại.'),{httpStatus:503,code:'TRUSTED_ROUTE_UNAVAILABLE'});
  return {distanceKm:route.distanceMeters/1000,durationMinutes:Math.max(1,Math.ceil(route.durationSeconds/60))};
}
module.exports={verifiedMetrics,extractLocation};
