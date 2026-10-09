const fs = require('fs');
const path = require('path');

const serverPath = path.resolve(__dirname, '../src/server.js');
let source = fs.readFileSync(serverPath, 'utf8');
let changed = false;

function addAfter(anchor, text) {
  if (source.includes(text.trim())) return;
  if (!source.includes(anchor)) throw new Error(`Không tìm thấy mốc trong server.js: ${anchor}`);
  source = source.replace(anchor, `${anchor}\n${text}`);
  changed = true;
}

addAfter(
  "const { createFundTopupRouter, createFundTopupAdminRouter } = require('./fund_topup_routes');",
  "const { createMerchantRegistrationRouter } = require('./merchant_registration_routes');\nconst { createLegalPublicRouter, createLegalAdminRouter } = require('./legal_routes');",
);

addAfter(
  "app.use('/api/v171/admin/funds', createFundTopupAdminRouter({ getDb:()=>db }));",
  "app.use('/api/v171/merchant-registration', createMerchantRegistrationRouter({ getDb:()=>db }));\napp.use('/api/v171/legal', createLegalPublicRouter({ getDb:()=>db }));\napp.use('/api/v171/admin/legal', createLegalAdminRouter({ getDb:()=>db }));",
);

if (changed) {
  fs.writeFileSync(serverPath, source, 'utf8');
  console.log('[OK] Đã cập nhật src/server.js cho Merchant Registration + Legal Settings.');
} else {
  console.log('[OK] server.js đã có đủ route, không cần sửa thêm.');
}
