'use strict';

const DEFAULT_ROUTING_URL = 'https://router.project-osrm.org';
const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

function number(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a finite number`);
  return parsed;
}

function assertLatLon(lat, lon) {
  const latitude = number(lat, 'latitude');
  const longitude = number(lon, 'longitude');
  if (latitude < -90 || latitude > 90) throw new RangeError('latitude must be between -90 and 90');
  if (longitude < -180 || longitude > 180) throw new RangeError('longitude must be between -180 and 180');
  return { latitude, longitude };
}

function normalizeSearchResults(items, query = '') {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const latitude = Number(item?.lat);
      const longitude = Number(item?.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const display = String(item?.display_name || '').trim();
      const name = String(item?.name || item?.namedetails?.name || display.split(',')[0] || display).trim();
      return {
        placeId: `osm:${String(item?.place_id ?? `${latitude},${longitude}`)}`,
        name: name || display || 'Vị trí OpenStreetMap',
        address: display || name || 'Vị trí OpenStreetMap',
        latitude,
        longitude,
        type: String(item?.type || item?.category || 'place'),
      };
    })
    .filter(Boolean);
}

function normalizeReverseResult(item, latitude, longitude) {
  const lat = Number(item?.lat ?? latitude);
  const lon = Number(item?.lon ?? longitude);
  const display = String(item?.display_name || '').trim();
  const name = String(item?.name || item?.namedetails?.name || display.split(',')[0] || display).trim();
  return {
    placeId: `osm:${String(item?.place_id ?? `${lat},${lon}`)}`,
    name: name || display || 'Vị trí đã chọn',
    address: display || name || `${lat.toFixed(6)}, ${lon.toFixed(6)}`,
    latitude: lat,
    longitude: lon,
    type: String(item?.type || item?.category || 'place'),
    provider: 'OPENSTREETMAP',
    matchQuality: 'NEARBY',
  };
}


// TrackAsia uses GeoJSON [longitude, latitude]. Do not mistake street-level
// coordinates for an exact house entrance when the provider lacks housenumber.
function queryHouseNumber(query) {
  const matched = String(query || '').trim().match(/^(\d+[a-z]?(?:\s*[/-]\s*\d+[a-z]?)*)\b/i);
  return matched ? matched[1].replace(/\s/g, '').toUpperCase() : '';
}

function houseMatchQuality(query, providerHouse, providerAddress = '') {
  const requested = queryHouseNumber(query);
  if (!requested) return 'PLACE';
  const actual = String(providerHouse || '').replace(/\s/g, '').toUpperCase();
  if (!actual || actual !== requested) return 'APPROXIMATE';
  // A matching number on another road must not be presented as the same house.
  const street = String(query).trim().replace(/^(\d+[a-z]?(?:\s*[/-]\s*\d+[a-z]?)*)\s*/i, '').split(',')[0].trim();
  const normalize = (value) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd');
  if (street.length >= 5 && !normalize(providerAddress).includes(normalize(street))) return 'APPROXIMATE';
  return 'EXACT_HOUSE';
}

function normalizeTrackAsiaResults(payload, query = '') {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const unique = new Set();
  return features.map((feature) => {
    const props = feature?.properties || {};
    const coords = feature?.geometry?.coordinates || [];
    const longitude = Number(coords[0]);
    const latitude = Number(coords[1]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
    const address = String(props.label || props.name || '').trim();
    if (!address) return null;
    const placeId = `trackasia:${String(props.gid || props.id || `${latitude},${longitude}`)}`;
    if (unique.has(placeId)) return null;
    unique.add(placeId);
    return {
      placeId,
      name: String(props.name || props.housenumber || address.split(',')[0] || address).trim(),
      address,
      latitude,
      longitude,
      type: String(props.layer || 'place'),
      provider: 'TRACKASIA',
      matchQuality: houseMatchQuality(query, props.housenumber, address),
    };
  }).filter(Boolean).sort((a,b) =>
    Number(b.matchQuality === 'EXACT_HOUSE') - Number(a.matchQuality === 'EXACT_HOUSE'));
}

function normalizeTrackAsiaReverse(payload, latitude, longitude) {
  const places = normalizeTrackAsiaResults(payload);
  if (!places.length) return null;
  // Reverse result is the nearest known address, not necessarily the actual door.
  return { ...places[0], matchQuality: 'NEARBY' };
}

// VIETMAP V4: autocomplete is suggestion-only (NO coordinates).
// Always resolve a selected ref_id with Place V4 before using it for a booking.
function normalizeVietMapSuggestions(payload, query = '') {
  const items = Array.isArray(payload) ? payload : [];
  const seen = new Set();
  return items.map((item) => {
    const refId = String(item?.ref_id || '').trim();
    const address = String(item?.display || item?.address || '').trim();
    if (!/^(auto|geocode):\S{1,2048}$/.test(refId) || !address || seen.has(refId)) return null;
    seen.add(refId);
    const name = String(item?.name || '').trim() || address.split(',')[0].trim();
    return {
      placeId: `vietmap:${refId}`,
      name, address,
      latitude: null, longitude: null, // Place V4 resolves these ONLY on selection
      type: 'place', provider: 'VIETMAP',
      // Text similarity is NOT proof of rooftop accuracy.
      matchQuality: queryHouseNumber(query) ? 'HOUSE_CANDIDATE' : 'PLACE',
    };
  }).filter(Boolean);
}

function normalizeVietMapPlace(item, placeId = 'vietmap:unknown') {
  const point = assertLatLon(item?.lat, item?.lng);
  const address = String(item?.display || item?.address || '').trim();
  const name = String(item?.name || '').trim() || address.split(',')[0].trim();
  if (!address) throw new Error('VietMap Place returned no address');
  return {
    placeId, name: name || address, address,
    latitude: point.latitude, longitude: point.longitude,
    type: 'place', provider: 'VIETMAP', matchQuality: 'NEARBY',
    // VietMap's explicit house number and street are used for post-selection
    // comparison. Never infer a verified house from suggestion text alone.
    houseNumber: String(item?.hs_num || '').trim(),
    street: String(item?.street || '').trim(),
  };
}

function normalizeVietMapReverse(payload, latitude, longitude) {
  const items = Array.isArray(payload) ? payload : payload && typeof payload === 'object' ? [payload] : [];
  const place = items.find((x) => x && (x.display || x.address));
  if (!place) return null;
  const address = String(place.display || place.address).trim();
  return {
    placeId: `vietmap:pin:${Number(latitude).toFixed(6)},${Number(longitude).toFixed(6)}`,
    name: String(place.name || '').trim() || address.split(',')[0].trim() || address,
    address, latitude: Number(latitude), longitude: Number(longitude),
    type: 'place', provider: 'VIETMAP', matchQuality: 'NEARBY',
  };
}

function normalizeRoute(payload, mode = 'BALANCED') {
  const routes = Array.isArray(payload?.routes) ? payload.routes.filter(Boolean) : [];
  const normalizedMode = String(mode || 'BALANCED').toUpperCase();
  const route = routes.sort((a,b) => {
    if (normalizedMode === 'SHORTEST') return Number(a.distance||Infinity) - Number(b.distance||Infinity);
    if (normalizedMode === 'FASTEST') return Number(a.duration||Infinity) - Number(b.duration||Infinity);
    const score = (x) => Number(x.duration||Infinity) + Number(x.distance||Infinity) / 8;
    return score(a) - score(b);
  })[0] || null;
  const coordinates = route?.geometry?.coordinates;
  if (!route || !Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error('Routing provider did not return a usable route');
  }
  const steps = (route.legs || []).flatMap((leg) => Array.isArray(leg?.steps) ? leg.steps : []).map((step) => ({
    type: String(step?.maneuver?.type || 'continue'),
    modifier: String(step?.maneuver?.modifier || ''),
    roadName: String(step?.name || '').trim(),
    distanceMeters: Math.max(0, Math.round(Number(step?.distance) || 0)),
    durationSeconds: Math.max(0, Math.round(Number(step?.duration) || 0)),
    latitude: Number(step?.maneuver?.location?.[1]),
    longitude: Number(step?.maneuver?.location?.[0]),
  })).filter((step) => Number.isFinite(step.latitude) && Number.isFinite(step.longitude));
  return {
    distanceMeters: Math.max(1, Math.round(Number(route.distance) || 0)),
    durationSeconds: Math.max(1, Math.round(Number(route.duration) || 0)),
    polylinePoints: coordinates.map((point) => ({
      latitude: Number(point[1]),
      longitude: Number(point[0]),
    })).filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude)),
    steps,
    isFallback: false,
  };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const radius = 6371000;
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function createFallbackRoute(fromLat, fromLon, toLat, toLon) {
  const from = assertLatLon(fromLat, fromLon);
  const to = assertLatLon(toLat, toLon);
  const direct = haversineMeters(from.latitude, from.longitude, to.latitude, to.longitude);
  const estimatedRoadDistance = Math.max(500, direct * 1.25);
  const estimatedBikeSpeedMps = 25_000 / 3600;
  return {
    distanceMeters: Math.round(estimatedRoadDistance),
    durationSeconds: Math.max(60, Math.round(estimatedRoadDistance / estimatedBikeSpeedMps)),
    polylinePoints: [from, to],
    steps: [],
    isFallback: true,
  };
}

function trimBaseUrl(value, fallback) {
  return String(value || fallback).trim().replace(/\/+$/, '');
}

function createMapService(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Global fetch is not available');

  const routingBaseUrl = trimBaseUrl(options.routingBaseUrl || process.env.OSM_ROUTING_URL, DEFAULT_ROUTING_URL);
  const tileUrl = String(options.tileUrl || process.env.OSM_TILE_URL || DEFAULT_TILE_URL).trim();
  const userAgent = String(options.userAgent || process.env.OSM_USER_AGENT || 'TH79-iMove (+https://daututh79.com)').trim();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || process.env.OSM_HTTP_TIMEOUT_MS || 7000));
  const cacheMs = Math.max(0, Number(options.cacheMs ?? process.env.OSM_GEOCODE_CACHE_MS ?? 300000));
  const cache = new Map();
  const vietMapKey = String(options.vietMapKey ?? process.env.VIETMAP_API_KEY ?? '').trim();
  const vietMapBaseUrl = trimBaseUrl(options.vietMapBaseUrl || process.env.VIETMAP_API_BASE_URL, 'https://maps.vietmap.vn');
  // Do not silently put a vendor key into an untrusted endpoint.
  if (!/^https:\/\//i.test(vietMapBaseUrl)) throw new Error('VIETMAP_API_BASE_URL must use HTTPS');
  // VietMap-only policy for address search and reverse-geocoding. Even if old
  // MAP_SEARCH_PROVIDER / VIETMAP_OSM_FALLBACK values remain in PM2/.env,
  // geocoding NEVER contacts Nominatim / OpenStreetMap.
  const searchProvider = 'VIETMAP';
  const fallbackToOsm = false;

  async function requestJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'Accept-Language': 'vi,en;q=0.8', 'User-Agent': userAgent },
        signal: controller.signal,
      });
      // Do not log the full URL (it contains the provider key).
      if (!response.ok) {
        const error = new Error(`Map provider HTTP ${response.status}`);
        error.httpStatus = response.status;
        throw error;
      }
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  async function cached(key, factory) {
    const existing = cache.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.value;
    const value = await factory();
    if (cacheMs > 0) cache.set(key, { value, expiresAt: Date.now() + cacheMs });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  }

  function assertVietMapConfigured() {
    if (vietMapKey) return;
    const error = new Error('VietMap chưa được cấu hình trên Backend. Kiểm tra VIETMAP_API_KEY.');
    error.code = 'VIETMAP_NOT_CONFIGURED';
    throw error;
  }

  async function search(query, { limit = 6, countryCode = 'vn', focusLat, focusLon, clientVersion = 2 } = {}) {
    // v1 APKs assume every suggestion includes coordinates. VietMap V4
    // suggestions do NOT contain coordinates; an old APK must be upgraded,
    // rather than receiving silently substituted OpenStreetMap results.
    if (Number(clientVersion) < 2) {
      const error = new Error('Phiên bản iMove cũ không hỗ trợ VietMap V4. Vui lòng cập nhật ứng dụng.');
      error.code = 'APP_UPDATE_REQUIRED';
      throw error;
    }
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    if (q.length > 120) throw new RangeError('query is too long');
    const safeLimit = Math.min(10, Math.max(1, Number(limit) || 6));
    const focus = focusLat !== undefined && focusLon !== undefined && focusLat !== '' && focusLon !== ''
      ? assertLatLon(focusLat, focusLon) : null;
    assertVietMapConfigured();
    const cacheKey = `s:VIETMAP_ONLY:${q.toLowerCase()}:${safeLimit}:${focus ? `${focus.latitude.toFixed(3)},${focus.longitude.toFixed(3)}` : ''}`;
    return cached(cacheKey, async () => {
      const params = new URLSearchParams({ apikey: vietMapKey, text: q, display_type: '5' });
      if (focus) params.set('focus', `${focus.latitude},${focus.longitude}`);
      try {
        const payload = await requestJson(`${vietMapBaseUrl}/api/autocomplete/v4?${params}`);
        return normalizeVietMapSuggestions(payload, q).slice(0, safeLimit);
      } catch (cause) {
        // Do not leak API key or full request URL in errors/logs.
        const error = new Error(
          cause.httpStatus === 401 ? 'VietMap từ chối API key (HTTP 401).' :
          cause.httpStatus === 423 ? 'VietMap đã hết hạn mức hoặc chưa được cấp quyền API (HTTP 423).' :
          'Không kết nối được VietMap. Hãy thử lại hoặc chọn ghim trên bản đồ.'
        );
        error.code = 'VIETMAP_UNAVAILABLE';
        error.httpStatus = cause.httpStatus;
        throw error;
      }
    });
  }

  async function placeDetails(placeId) {
    const id = String(placeId || '').trim();
    if (!id.startsWith('vietmap:')) throw new RangeError('Unsupported Place ID');
    const refid = id.slice('vietmap:'.length);
    if (refid.length > 2048 || !/^(auto|geocode):\S{1,2048}$/.test(refid)) throw new RangeError('Invalid VietMap Place ref_id');
    if (!vietMapKey) {
      const error = new Error('VietMap chưa được cấu hình trên Backend (VIETMAP_API_KEY).');
      error.code = 'VIETMAP_NOT_CONFIGURED';
      throw error;
    }
    return cached(`place:${refid}`, async () => {
      const params = new URLSearchParams({ apikey: vietMapKey, refid });
      return normalizeVietMapPlace(await requestJson(`${vietMapBaseUrl}/api/place/v4?${params}`), id);
    });
  }

  async function reverse(latitude, longitude) {
    const point = assertLatLon(latitude, longitude);
    assertVietMapConfigured();
    const cacheKey = `r:VIETMAP_ONLY:${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`;
    return cached(cacheKey, async () => {
      const params = new URLSearchParams({ apikey: vietMapKey, lat: String(point.latitude), lng: String(point.longitude), display_type: '5' });
      try {
        const payload = await requestJson(`${vietMapBaseUrl}/api/reverse/v4?${params}`);
        return normalizeVietMapReverse(payload, point.latitude, point.longitude);
      } catch (cause) {
        const error = new Error(
          cause.httpStatus === 401 ? 'VietMap từ chối API key (HTTP 401).' :
          cause.httpStatus === 423 ? 'VietMap hết hạn mức hoặc thiếu quyền Reverse (HTTP 423).' :
          'Không lấy được địa chỉ từ VietMap. Có thể nhập địa chỉ thủ công khi chọn ghim.'
        );
        error.code = 'VIETMAP_UNAVAILABLE';
        error.httpStatus = cause.httpStatus;
        throw error;
      }
    });
  }

  async function route(fromLat, fromLon, toLat, toLon, options = {}) {
    const from = assertLatLon(fromLat, fromLon);
    const to = assertLatLon(toLat, toLon);
    const vehicleType = String(options.vehicleType || 'MOTORBIKE').toUpperCase();
    const mode = String(options.mode || 'BALANCED').toUpperCase();
    const profileKey = `ROUTING_PROFILE_${vehicleType}`;
    const profile = String(process.env[profileKey] || process.env.ROUTING_PROFILE_DEFAULT || 'driving').trim();
    const path = `/route/v1/${encodeURIComponent(profile)}/${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const params = new URLSearchParams({ overview: 'full', geometries: 'geojson', steps: 'true', alternatives: 'true' });
    const result = normalizeRoute(await requestJson(`${routingBaseUrl}${path}?${params}`), mode);
    return { ...result, vehicleType, routeMode: mode, routingProfile: profile };
  }

  function publicConfig() {
    return {
      // TrackAsia map rendering lives in Flutter TrackAsiaMapView, unchanged.
      provider: 'TRACKASIA', // the visible Flutter map; legacy tileUrl below is NOT used for address search
      displayMapProvider: 'TRACKASIA', // Flutter TrackAsia SDK unchanged
      geocodingProvider: searchProvider,
      searchIntegrationVersion: 'VIETMAP_V4_ONLY',
      searchProviderLocked: true,
      vietmapKeyConfigured: Boolean(vietMapKey), // key value is NEVER sent to clients
      osmFallbackEnabled: false,
      tileUrl,
      attribution: '© OpenStreetMap contributors',
      geocodingViaBackend: true, routingViaBackend: true,
      routeModes: ['BALANCED', 'FASTEST', 'SHORTEST'],
      vehicleTypes: ['MOTORBIKE', 'CAR', 'VAN', 'TRUCK'],
    };
  }
  return { search, placeDetails, reverse, route, publicConfig };
}

module.exports = {
  assertLatLon,
  normalizeSearchResults,
  normalizeReverseResult,
  normalizeTrackAsiaResults,
  normalizeVietMapSuggestions,
  normalizeVietMapPlace,
  normalizeVietMapReverse,
  queryHouseNumber,
  houseMatchQuality,
  normalizeRoute,
  createFallbackRoute,
  createMapService,
};
