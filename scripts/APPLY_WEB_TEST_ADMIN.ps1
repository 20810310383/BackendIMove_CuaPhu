# TH79 iMove - safely inject 3 small integration points into the EXISTING server.js.
# Runs in Windows PowerShell, keeping all existing backend updates intact.
$ErrorActionPreference = 'Stop'
$file = Join-Path $PSScriptRoot '..\src\server.js'
$file = [System.IO.Path]::GetFullPath($file)
if (!(Test-Path $file)) { throw "Cannot find server.js: $file" }
$source = [System.IO.File]::ReadAllText($file)
$original = $source

$importAnchor = "const { assertProductionConfig, buildCorsOptions } = require('./production_guard');"
$importAdd = @"
const { createWebTestCorsController } = require('./web_test_cors');
const { createWebTestCorsAdminRouter } = require('./web_test_cors_admin_routes');
"@
if (!$source.Contains("require('./web_test_cors')")) {
    if (!$source.Contains($importAnchor)) { throw 'Import anchor not found. Do not overwrite server.js; inspect manually.' }
    $source = $source.Replace($importAnchor, $importAnchor + "`n" + $importAdd)
}

$oldCors = 'app.use(cors(buildCorsOptions()));'
$newCors = @'
// Dynamic, time-limited localhost access controlled from Admin settings.
const webTestCorsController = createWebTestCorsController({ getDb: () => db });
app.use(cors(buildCorsOptions({ isLocalTestOriginAllowed: webTestCorsController.isAllowedOrigin })));
'@
if (!$source.Contains('isLocalTestOriginAllowed: webTestCorsController.isAllowedOrigin')) {
    if (!$source.Contains($oldCors)) { throw 'CORS anchor not found. Do not overwrite server.js; inspect manually.' }
    $source = $source.Replace($oldCors, $newCors)
}

$mountAnchor = 'app.use(adminConsoleRouter);'
$mountAdd = @'
// Permission-protected API: GET/PUT /api/v188/admin/web-test-cors.
app.use('/api/v188/admin', createWebTestCorsAdminRouter({ getDb: () => db, controller: webTestCorsController }));
'@
if (!$source.Contains("createWebTestCorsAdminRouter({ getDb: () => db")) {
    if (!$source.Contains($mountAnchor)) { throw 'Admin router anchor not found. Do not overwrite server.js; inspect manually.' }
    $source = $source.Replace($mountAnchor, $mountAnchor + "`n" + $mountAdd)
}

# Check every expected anchor before touching disk.
foreach ($expected in @("require('./web_test_cors')", 'isLocalTestOriginAllowed: webTestCorsController.isAllowedOrigin', 'createWebTestCorsAdminRouter({ getDb: () => db')) {
    if (!$source.Contains($expected)) { throw "Patch validation failed: $expected" }
}
if ($source -ne $original) {
    $backup = "$file.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
    [System.IO.File]::Copy($file, $backup, $true)
    [System.IO.File]::WriteAllText($file, $source, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Patched: $file" -ForegroundColor Green
    Write-Host "Backup:  $backup"
} else {
    Write-Host 'server.js already patched. No changes needed.' -ForegroundColor Green
}
Write-Host 'Next: node --check src/server.js'
