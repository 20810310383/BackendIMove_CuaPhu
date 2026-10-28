// Supports both Driver API payload conventions without inventing a GPS location.
function parseDriverHeartbeatLocation(payload = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const rawLat = p.latitude ?? p.lat;
  const rawLng = p.longitude ?? p.lng ?? p.lon;
  if (rawLat === undefined || rawLat === null || rawLat === '' || rawLng === undefined || rawLng === null || rawLng === '') {
    return { hasCoordinates: false, reason: 'GPS_NOT_SENT' };
  }
  const latitude = Number(rawLat);
  const longitude = Number(rawLng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || (latitude === 0 && longitude === 0)) {
    return { hasCoordinates: false, reason: 'GPS_INVALID' };
  }
  return { hasCoordinates: true, latitude, longitude,
    heading: p.heading, speedKph: p.speedKph ?? p.speed, accuracyM: p.accuracyM ?? p.accuracy };
}
module.exports = { parseDriverHeartbeatLocation };
