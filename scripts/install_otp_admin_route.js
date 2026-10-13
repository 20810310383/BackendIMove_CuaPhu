const fs = require('fs');
const path = require('path');

const serverPath = path.resolve(__dirname, '../src/server.js');
let source = fs.readFileSync(serverPath, 'utf8');
let changed = false;

if (!source.includes("createOtpAdminRouter")) {
  const importRegex = /const\s+\{\s*createAuthRouter\s*\}\s*=\s*require\(['\"]\.\/auth_routes['\"]\);?/;
  const match = source.match(importRegex);
  if (!match) throw new Error('Không tìm thấy import createAuthRouter trong src/server.js');
  source = source.replace(match[0], `${match[0]}\nconst { createOtpAdminRouter } = require('./otp_admin_routes');`);
  changed = true;
}

if (!source.includes("/api/v171/admin/otp")) {
  const mountRegex = /app\.use\(['\"]\/api\/auth['\"],\s*createAuthRouter\(\{\s*getDb:\s*\(\)\s*=>\s*db\s*\}\)\);?/;
  const match = source.match(mountRegex);
  if (!match) throw new Error('Không tìm thấy app.use(/api/auth...) trong src/server.js');
  source = source.replace(match[0], `${match[0]}\napp.use('/api/v171/admin/otp', createOtpAdminRouter({ getDb: () => db }));`);
  changed = true;
}

if (changed) {
  fs.writeFileSync(serverPath, source, 'utf8');
  console.log('[OK] Đã gắn OTP Admin API vào src/server.js');
} else {
  console.log('[SKIP] OTP Admin API đã được gắn trước đó.');
}
