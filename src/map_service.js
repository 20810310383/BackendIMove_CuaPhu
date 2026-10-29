'use strict';

const DEFAULT_GEOCODING_URL = 'https://nominatim.openstreetmap.org';
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
        provider: 'OPENSTREETMAP',
        matchQuality: houseMatchQuality(query, item?.address?.house_number, display),
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

  const geocodingBaseUrl = trimBaseUrl(options.geocodingBaseUrl || process.env.OSM_GEOCODING_URL, DEFAULT_GEOCODING_URL);
  const routingBaseUrl = trimBaseUrl(options.routingBaseUrl || process.env.OSM_ROUTING_URL, DEFAULT_ROUTING_URL);
  const tileUrl = String(options.tileUrl || process.env.OSM_TILE_URL || DEFAULT_TILE_URL).trim();
  const userAgent = String(options.userAgent || process.env.OSM_USER_AGENT || 'TH79-iMove/1.6.0 (+https://daututh79.com)').trim();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || process.env.OSM_HTTP_TIMEOUT_MS || 7000));
  const cacheMs = Math.max(0, Number(options.cacheMs || process.env.OSM_GEOCODE_CACHE_MS || 300000));
  const cache = new Map();
  const trackAsiaKey = String(options.trackAsiaKey ?? process.env.TRACKASIA_API_KEY ?? '').trim();
  const trackAsiaBaseUrl = trimBaseUrl(options.trackAsiaBaseUrl || process.env.TRACKASIA_API_BASE_URL, 'https://maps.track-asia.com');

  async function requestJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'vi,en;q=0.8',
          'User-Agent': userAgent,
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Map provider HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function cached(key, factory) {
    const existing = cache.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.value;
    const value = await factory();
    if (cacheMs > 0) cache.set(key, { value, expiresAt: Date.now() + cacheMs });
    if (cache.size > 500) {
      const first = cache.keys().next().value;
      cache.delete(first);
    }
    return value;
  }

  async function search(query, { limit = 5, countryCode = 'vn', focusLat, focusLon } = {}) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    if (q.length > 120) throw new RangeError('query is too long');
    const safeLimit = Math.min(8, Math.max(1, Number(limit) || 5));
    const focus = Number.isFinite(Number(focusLat)) && Number.isFinite(Number(focusLon)) &&
      focusLat !== undefined && focusLon !== undefined ? assertLatLon(focusLat, focusLon) : null;
    const cacheKey = `s:${q.toLowerCase()}:${safeLimit}:${countryCode}:${focus ? `${focus.latitude.toFixed(3)},${focus.longitude.toFixed(3)}` : ''}:${Boolean(trackAsiaKey)}`;
    return cached(cacheKey, async () => {
      if (trackAsiaKey) {
        // Exact-address entry -> TrackAsia Search. Partial entry -> Autocomplete.
        const endpoint = queryHouseNumber(q) ? '/api/v1/search' : '/api/v1/autocomplete';
        const params = new URLSearchParams({ text: q, lang: 'vi', size: String(safeLimit), key: trackAsiaKey, new_admin: 'true', include_old_admin: 'true' });
        if (focus) {
          params.set('focus.point.lat', String(focus.latitude));
          params.set('focus.point.lon', String(focus.longitude));
        }
        try {
          const payload = await requestJson(`${trackAsiaBaseUrl}${endpoint}?${params}`);
          const results = normalizeTrackAsiaResults(payload, q);
          if (results.length) return results.slice(0, safeLimit);
        } catch (error) {
          // Never log a URL with an API key. Old OSM is fallback, not primary.
          console.warn('[iMove Maps] TrackAsia search unavailable:', String(error.message).slice(0, 120));
        }
      }
      const params = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', namedetails: '1', limit: String(safeLimit) });
      if (countryCode) params.set('countrycodes', String(countryCode).toLowerCase());
      const results = normalizeSearchResults(await requestJson(`${geocodingBaseUrl}/search?${params}`), q);
      return results.slice(0, safeLimit);
    });
  }

  async function reverse(latitude, longitude) {
    const point = assertLatLon(latitude, longitude);
    const cacheKey = `r:${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}:${Boolean(trackAsiaKey)}`;
    return cached(cacheKey, async () => {
      if (trackAsiaKey) {
        const params = new URLSearchParams({
          'point.lat': String(point.latitude),
          'point.lon': String(point.longitude),
          'size': '5',
          'lang': 'vi',
          'new_admin': 'true',
          'include_old_admin': 'true',
          'key': trackAsiaKey,
        });
        try {
          const result = normalizeTrackAsiaReverse(
            await requestJson(`${trackAsiaBaseUrl}/api/v1/reverse?${params}`),
            point.latitude, point.longitude,
          );
          if (result) return result;
        } catch (error) {
          console.warn('[iMove Maps] TrackAsia reverse unavailable:', String(error.message).slice(0, 120));
        }
      }
      const params = new URLSearchParams({
        lat: String(point.latitude), lon: String(point.longitude),
        format: 'jsonv2', addressdetails: '1', namedetails: '1', zoom: '18',
      });
      return normalizeReverseResult(
        await requestJson(`${geocodingBaseUrl}/reverse?${params}`),
        point.latitude, point.longitude,
      );
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
      provider: trackAsiaKey ? 'TRACKASIA' : 'OPENSTREETMAP',
      geocodingProvider: trackAsiaKey ? 'TRACKASIA' : 'OPENSTREETMAP',
      tileUrl,
      attribution: '© OpenStreetMap contributors',
      geocodingViaBackend: true,
      routingViaBackend: true,
      routeModes: ['BALANCED','FASTEST','SHORTEST'],
      vehicleTypes: ['MOTORBIKE','CAR','VAN','TRUCK'],
    };
  }

  return { search, reverse, route, publicConfig };
}

module.exports = {
  assertLatLon,
  normalizeSearchResults,
  normalizeReverseResult,
  normalizeTrackAsiaResults,
  queryHouseNumber,
  houseMatchQuality,
  normalizeRoute,
  createFallbackRoute,
  createMapService,
};
