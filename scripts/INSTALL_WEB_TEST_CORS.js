'use strict';
// Safely install the Admin Web Test CORS API into the EXISTING Core Backend.
// Preserves existing business logic and creates dated backups of modified files.
// Usage: node scripts/INSTALL_WEB_TEST_CORS.js --check
//        node scripts/INSTALL_WEB_TEST_CORS.js --apply
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');
const serverPath = path.join(src, 'server.js');
const guardPath = path.join(src, 'production_guard.js');
const mode = process.argv[2];
const guardFn = String.raw`function buildCorsOptions({ isLocalTestOriginAllowed = null } = {}) {
  const production = String(process.env.NODE_ENV || 'development').trim().toLowerCase() === 'production';
  if (!production) return { origin: true, credentials: true };

  const allowed = new Set(csv('CORS_ORIGINS'));
  return {
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowed.has(origin)) return callback(null, true);
      try {
        const parsed = new URL(origin);
        const validOrigin = parsed.origin === origin && parsed.protocol === 'https:';
        if (validOrigin && [...allowed].some(pattern => {
          if (!pattern.startsWith('https://*.')) return false;
          const suffix = pattern.slice('https://*.'.length).toLowerCase();
          return parsed.hostname.toLowerCase().endsWith('.' + suffix) && parsed.hostname.length > suffix.length + 1 && !parsed.port;
        })) return callback(null, true);
      } catch (_) { /* malformed origin denied */ }
      // Dynamic policy is allowed ONLY for loopback dev origins.
      if (typeof isLocalTestOriginAllowed === 'function' &&
          /^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]{1,5}$/.test(origin)) {
        Promise.resolve().then(() => isLocalTestOriginAllowed(origin))
          .then(granted => callback(null, granted === true))
          .catch(() => callback(null, false));
        return;
      }
      // No HTTP 500 for disallowed origins: browser enforces denial.
      return callback(null, false);
    },
  };
}
`;

function assertRequired(condition, message) { if (!condition) throw new Error(message); }
function count(haystack, needle) { return haystack.split(needle).length - 1; }

function patchFiles() {
  assertRequired(['--apply', '--check'].includes(mode), 'Usage: node scripts/INSTALL_WEB_TEST_CORS.js --check | --apply');
  for (const f of ['server.js', 'production_guard.js', 'web_test_cors.js', 'web_test_cors_admin_routes.js']) {
    assertRequired(fs.existsSync(path.join(src, f)), `Thiếu src/${f}; hãy chép đủ 2 module mới trước.`);
  }
  const beforeServer = fs.readFileSync(serverPath, 'utf8');
  const beforeGuard = fs.readFileSync(guardPath, 'utf8');
  let server = beforeServer;
  let guard = beforeGuard;

  // Replace ONLY buildCorsOptions, preserving the rest of production_guard.js.
  const start = guard.indexOf('function buildCorsOptions(');
  const end = guard.indexOf('\nmodule.exports = ', start);
  assertRequired(start >= 0 && end > start, 'Không tìm thấy hàm buildCorsOptions hoặc module.exports trong production_guard.js. Dừng để tránh ghi đè sai.');
  assertRequired(guard.includes('function csv('), 'production_guard.js khác cấu trúc dự kiến. Dừng để tránh ghi đè sai.');
  guard = guard.slice(0, start) + guardFn + guard.slice(end);

  const importAnchor = "const { assertProductionConfig, buildCorsOptions } = require('./production_guard');";
  const impController = "const { createWebTestCorsController } = require('./web_test_cors');";
  const impRouter = "const { createWebTestCorsAdminRouter } = require('./web_test_cors_admin_routes');";
  const corsAnchor = 'app.use(cors(buildCorsOptions()));';
  const corsPatched = 'app.use(cors(buildCorsOptions({ isLocalTestOriginAllowed: webTestCorsController.isAllowedOrigin })));';
  const controllerDeclaration = 'const webTestCorsController = createWebTestCorsController({ getDb: () => db });';
  const mountAnchor = 'app.use(adminConsoleRouter);';
  const mount = "app.use('/api/v188/admin', createWebTestCorsAdminRouter({ getDb: () => db, controller: webTestCorsController }));";

  if (!server.includes(impController) || !server.includes(impRouter)) {
    assertRequired(count(server, importAnchor) === 1, 'Không tìm thấy vị trí import production_guard trong server.js.');
    const extras = [!server.includes(impController) ? impController : '', !server.includes(impRouter) ? impRouter : ''].filter(Boolean).join('\n');
    server = server.replace(importAnchor, importAnchor + '\n' + extras);
  }
  if (!server.includes(controllerDeclaration)) {
    assertRequired(count(server, corsAnchor) === 1, 'Không tìm thấy CORS middleware gốc; nếu server.js đã đổi cấu trúc, cần đối chiếu thủ công.');
    server = server.replace(corsAnchor, controllerDeclaration + '\n' + corsPatched);
  } else {
    if (!server.includes(corsPatched)) {
      assertRequired(count(server, corsAnchor) === 1, 'Có controller nhưng CORS không khớp cấu trúc.');
      server = server.replace(corsAnchor, corsPatched);
    }
  }
  if (!server.includes(mount)) {
    assertRequired(count(server, mountAnchor) === 1, 'Không tìm thấy app.use(adminConsoleRouter);');
    server = server.replace(mountAnchor, mountAnchor + '\n' + mount);
  }
  for (const snippet of [impController, impRouter, controllerDeclaration, corsPatched, mount]) {
    assertRequired(count(server, snippet) === 1, `Kết nối API chưa đầy đủ hoặc trùng: ${snippet}`);
  }
  assertRequired(server.indexOf(controllerDeclaration) < server.indexOf(corsPatched), 'Thứ tự controller/CORS không hợp lệ.');
  assertRequired(server.indexOf(corsPatched) < server.indexOf(mount), 'Thứ tự CORS/API không hợp lệ.');
  // `node --check`-equivalent syntax validation before writing to live files.
  const vm = require('vm');
  for (const [name, source] of [['server.js', server], ['production_guard.js', guard]]) {
    try { new vm.Script(source, { filename: name }); }
    catch (e) { throw new Error(`Mã sau sửa không hợp lệ (${name}): ${e.message}`); }
  }
  const changes = [['src/server.js', serverPath, beforeServer, server], ['src/production_guard.js', guardPath, beforeGuard, guard]];
  console.log('Điểm kết nối:', 'GET/PUT /api/v188/admin/web-test-cors');
  for (const [name, , a, b] of changes) console.log(`${name}: ${a === b ? 'đã có bản sửa' : 'cần cập nhật'}`);
  if (mode === '--check') { console.log('CHỈ KIỂM TRA – chưa ghi file.'); return; }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  for (const [name, file, a, b] of changes) {
    if (a === b) continue;
    const backup = `${file}.backup-webtest-${stamp}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    const temp = `${file}.tmp-webtest-${process.pid}`;
    fs.writeFileSync(temp, b, 'utf8');
    fs.renameSync(temp, file);
    console.log(`ĐÃ SỬA ${name} | sao lưu ${path.basename(backup)}`);
  }
  console.log('HOÀN TẤT. Hãy chạy node --check và triển khai lại Backend hiện đang phục vụ VPS.');
}
try { patchFiles(); } catch (e) { console.error('DỪNG AN TOÀN:', e.message); process.exitCode = 1; }
