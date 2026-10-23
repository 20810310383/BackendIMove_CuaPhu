'use strict';

// This feature does NOT bypass authentication, OTP, authorization or TLS.
// It only authorizes temporary cross-origin browser requests from a Flutter
// development server running on an exact loopback hostname.
const DOCUMENT_ID = 'WEB_TEST_CORS_V1';
const COLLECTION = 'system_settings';
const CACHE_TTL_MS = 2000;
const VALID_DURATIONS = Object.freeze([30, 60, 120]);

function isLoopbackWebOrigin(origin) {
  if (typeof origin !== 'string') return false;
  try {
    const parsed = new URL(origin);
    const port = Number(parsed.port);
    return parsed.origin === origin && parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
      /^\d{1,5}$/.test(parsed.port) && port >= 1024 && port <= 65535 &&
      parsed.pathname === '/' && !parsed.username && !parsed.password &&
      !parsed.search && !parsed.hash;
  } catch (_) { return false; }
}

function normalize(row, now = new Date()) {
  const expiresAt = row?.expiresAt ? new Date(row.expiresAt) : null;
  const enabled = row?.enabled === true && Boolean(expiresAt) &&
    Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > now.getTime();
  return {
    enabled,
    expiresAt: expiresAt && Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : null,
    updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    autoDisableMinutes: 60,
    localHosts: ['localhost', '127.0.0.1'],
    allowedPortRange: '1024-65535',
  };
}

function createWebTestCorsController({ getDb, clock = () => new Date() }) {
  if (typeof getDb !== 'function') throw new TypeError('getDb is required');
  let lastRead = 0;
  let cached = null;
  let inflight = null;

  async function readRow(force = false) {
    const now = clock();
    if (!force && cached !== null && now.getTime() - lastRead < CACHE_TTL_MS) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
      const db = getDb();
      if (!db) throw new Error('DATABASE_UNAVAILABLE');
      const doc = await db.collection(COLLECTION).findOne({ _id: DOCUMENT_ID });
      cached = doc || { enabled: false };
      lastRead = clock().getTime();
      return cached;
    })();
    try { return await inflight; }
    catch (err) { cached = null; lastRead = 0; throw err; }
    finally { inflight = null; }
  }

  async function isAllowedOrigin(origin) {
    if (!isLoopbackWebOrigin(origin)) return false;
    try { return normalize(await readRow(), clock()).enabled; }
    catch (_) { return false; } // Fail closed when MongoDB is unavailable.
  }

  async function status() {
    return normalize(await readRow(true), clock());
  }

  async function update({ enabled, minutes = 60, actorId }) {
    if (typeof enabled !== 'boolean') {
      const error = new TypeError('enabled phải là true hoặc false.');
      error.httpStatus = 400;
      throw error;
    }
    if (enabled && !VALID_DURATIONS.includes(Number(minutes))) {
      const error = new RangeError('Thời gian chỉ được chọn 30, 60 hoặc 120 phút.');
      error.httpStatus = 400;
      throw error;
    }
    const db = getDb();
    if (!db) { const e = new Error('MongoDB chưa sẵn sàng.'); e.httpStatus = 503; throw e; }
    const now = clock();
    const before = normalize(await readRow(true), now);
    const expiresAt = enabled ? new Date(now.getTime() + Number(minutes) * 60000) : now;
    const patch = {
      enabled,
      expiresAt,
      updatedAt: now,
      updatedBy: actorId || null,
    };
    await db.collection(COLLECTION).updateOne(
      { _id: DOCUMENT_ID },
      { $set: patch },
      { upsert: true },
    );
    // Read-your-writes is immediate on this worker; other PM2 workers refresh
    // their cached snapshot within two seconds.
    cached = { _id: DOCUMENT_ID, ...patch };
    lastRead = now.getTime();
    const after = normalize(cached, now);
    try {
      await db.collection('audit_logs').insertOne({
        actorType: 'ADMIN',
        actorId: actorId || null,
        action: enabled ? 'WEB_TEST_CORS_ENABLED' : 'WEB_TEST_CORS_DISABLED',
        entityType: 'SYSTEM_SETTING',
        entityId: DOCUMENT_ID,
        before: { enabled: before.enabled, expiresAt: before.expiresAt },
        after: { enabled: after.enabled, expiresAt: after.expiresAt },
        createdAt: now,
      });
    } catch (error) {
      // The policy was saved; do not lie to the UI about save success.
      console.error('[WEB_TEST_CORS_AUDIT]', error.message);
    }
    return after;
  }

  return { isAllowedOrigin, status, update };
}

module.exports = {
  createWebTestCorsController,
  isLoopbackWebOrigin,
  normalize,
  DOCUMENT_ID,
  VALID_DURATIONS,
};
