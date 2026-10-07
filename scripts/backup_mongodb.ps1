param(
  [string]$MongoUri = $env:MONGODB_URI,
  [string]$DbName = $(if ($env:MONGODB_DB) { $env:MONGODB_DB } else { "th79_imove" }),
  [string]$OutDir = ".\backups"
)
if (-not $MongoUri) { throw "Thiếu MONGODB_URI." }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$file = Join-Path $OutDir "th79_imove_$stamp.archive.gz"
& mongodump --uri=$MongoUri --db=$DbName --archive=$file --gzip
if ($LASTEXITCODE -ne 0) { throw "mongodump thất bại." }
Write-Host "Backup OK: $file"
