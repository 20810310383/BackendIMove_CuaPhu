const fs = require('fs');
const path = require('path');

const serverPath = path.resolve(__dirname, '../src/server.js');
if (!fs.existsSync(serverPath)) {
  throw new Error(`Không tìm thấy ${serverPath}`);
}

let source = fs.readFileSync(serverPath, 'utf8');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${serverPath}.bak-legal-${stamp}`;
fs.copyFileSync(serverPath, backupPath);
let changed = false;

function insertAfter(anchor, text, label) {
  if (source.includes(text.trim())) return;
  if (!source.includes(anchor)) {
    throw new Error(`Không tìm thấy mốc ${label}: ${anchor}`);
  }
  source = source.replace(anchor, `${anchor}\n${text}`);
  changed = true;
}

// 1) Require route modules.
if (!source.includes("require('./legal_routes')")) {
  const anchor = "const { createFundTopupRouter, createFundTopupAdminRouter } = require('./fund_topup_routes');";
  insertAfter(
    anchor,
    "const { createLegalPublicRouter, createLegalAdminRouter } = require('./legal_routes');",
    'require fund_topup_routes',
  );
}

if (!source.includes("require('./feature_settings_routes')")) {
  const legalImport = "const { createLegalPublicRouter, createLegalAdminRouter } = require('./legal_routes');";
  if (source.includes(legalImport)) {
    insertAfter(
      legalImport,
      "const { createFeatureSettingsPublicRouter, createFeatureSettingsAdminRouter } = require('./feature_settings_routes');",
      'require legal_routes',
    );
  } else {
    const anchor = "const { createFundTopupRouter, createFundTopupAdminRouter } = require('./fund_topup_routes');";
    insertAfter(
      anchor,
      "const { createFeatureSettingsPublicRouter, createFeatureSettingsAdminRouter } = require('./feature_settings_routes');",
      'require fund_topup_routes',
    );
  }
}

// 2) Mount public/admin APIs.
const mountBlock = [
  "app.use('/api/v171/legal', createLegalPublicRouter({ getDb:()=>db }));",
  "app.use('/api/v171/admin/legal', createLegalAdminRouter({ getDb:()=>db }));",
  "app.use('/api/v180/app-settings', createFeatureSettingsPublicRouter({ getDb:()=>db }));",
  "app.use('/api/v180/admin/app-settings', createFeatureSettingsAdminRouter({ getDb:()=>db }));",
].join('\n');

const missingMount = [
  "/api/v171/legal",
  "/api/v171/admin/legal",
  "/api/v180/app-settings",
  "/api/v180/admin/app-settings",
].some((x) => !source.includes(x));

if (missingMount) {
  const anchor = "app.use('/api/v171/admin/funds', createFundTopupAdminRouter({ getDb:()=>db }));";
  if (!source.includes(anchor)) {
    throw new Error('Không tìm thấy route /api/v171/admin/funds để gắn Legal/App Settings.');
  }

  // Insert only the routes that are still missing.
  const lines = [];
  if (!source.includes("/api/v171/legal")) lines.push("app.use('/api/v171/legal', createLegalPublicRouter({ getDb:()=>db }));");
  if (!source.includes("/api/v171/admin/legal")) lines.push("app.use('/api/v171/admin/legal', createLegalAdminRouter({ getDb:()=>db }));");
  if (!source.includes("/api/v180/app-settings")) lines.push("app.use('/api/v180/app-settings', createFeatureSettingsPublicRouter({ getDb:()=>db }));");
  if (!source.includes("/api/v180/admin/app-settings")) lines.push("app.use('/api/v180/admin/app-settings', createFeatureSettingsAdminRouter({ getDb:()=>db }));");
  source = source.replace(anchor, `${anchor}\n${lines.join('\n')}`);
  changed = true;
}

if (changed) {
  fs.writeFileSync(serverPath, source, 'utf8');
  console.log('[OK] Đã gắn API Điều khoản/Chính sách + App Settings vào src/server.js');
} else {
  console.log('[OK] server.js đã có đủ route, không cần sửa.');
}

console.log(`[BACKUP] ${backupPath}`);
console.log('Public legal  : GET /api/v171/legal');
console.log('Admin legal   : GET/PUT /api/v171/admin/legal');
console.log('Public config : GET /api/v180/app-settings');
console.log('Admin config  : GET/PUT /api/v180/admin/app-settings');
