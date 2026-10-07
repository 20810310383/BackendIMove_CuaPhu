function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function locationReason(latitude, longitude, updatedAt, now, maxAgeSeconds) {
  if (latitude === null || longitude === null) return 'MISSING_COORDINATES';
  if (Math.abs(latitude) > 85.0511 || Math.abs(longitude) > 180) return 'OUT_OF_RANGE';
  if (latitude === 0 && longitude === 0) return 'ZERO_COORDINATES';
  if (!updatedAt) return 'MISSING_TIMESTAMP';
  const ageMs = Math.max(0, now.getTime() - updatedAt.getTime());
  if (ageMs > maxAgeSeconds * 1000) return 'STALE';
  return null;
}

function normalizeDriverLocation(locationDoc, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const maxAgeSeconds = Math.max(30, Number(options.maxAgeSeconds || 120));
  const coordinates = Array.isArray(locationDoc?.location?.coordinates)
    ? locationDoc.location.coordinates
    : [];
  const longitude = finiteNumber(coordinates[0]);
  const latitude = finiteNumber(coordinates[1]);
  const updatedAtValue = locationDoc?.updatedAt || locationDoc?.locationUpdatedAt || null;
  const updatedAt = updatedAtValue ? new Date(updatedAtValue) : null;
  const validUpdatedAt = updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null;
  const reason = locationReason(latitude, longitude, validUpdatedAt, now, maxAgeSeconds);
  const locationAgeSeconds = validUpdatedAt
    ? Math.max(0, Math.round((now.getTime() - validUpdatedAt.getTime()) / 1000))
    : null;

  return {
    latitude: reason ? null : latitude,
    longitude: reason ? null : longitude,
    locationUpdatedAt: toIso(validUpdatedAt),
    locationAgeSeconds,
    locationAccuracyM: finiteNumber(locationDoc?.accuracyM ?? locationDoc?.accuracy),
    locationValid: !reason,
    locationReason: reason,
  };
}

function mergeDriversWithLocations(drivers, locations, options = {}) {
  const byDriverId = new Map();
  for (const item of (Array.isArray(locations) ? locations : [])) {
    if (item?.driverId == null) continue;
    const key = String(item.driverId);
    const existing = byDriverId.get(key);
    const itemTime = new Date(item?.updatedAt || 0).getTime();
    const existingTime = new Date(existing?.updatedAt || 0).getTime();
    if (!existing || itemTime > existingTime) byDriverId.set(key, item);
  }

  return (Array.isArray(drivers) ? drivers : []).map((driver) => {
    const locationDoc = byDriverId.get(String(driver?._id));
    const gps = normalizeDriverLocation(locationDoc, options);
    return {
      id: String(driver._id),
      userId: driver.userId ? String(driver.userId) : null,
      onlineStatus: driver.onlineStatus || 'OFFLINE',
      activeBookingId: driver.activeBookingId ? String(driver.activeBookingId) : null,
      ...gps,
      locationSource: locationDoc ? 'driver_locations' : null,
      updatedAt: toIso(driver.updatedAt),
    };
  });
}

module.exports = {
  normalizeDriverLocation,
  mergeDriversWithLocations,
};
