# TH79 iMove Backend V5.8.2 - One maintenance menu
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Pause-TH79 {
  Write-Host ""
  Read-Host "Nhan Enter de quay lai menu"
}

function Ensure-NodeModules {
  $needInstall = -not (Test-Path ".\node_modules")
  if (-not $needInstall) {
    node -e "require.resolve('socket.io')" *> $null
    if ($LASTEXITCODE -ne 0) { $needInstall = $true }
  }
  if ($needInstall) {
    Write-Host "Dang cai/cap nhat npm dependencies V5.8..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install that bai." }
  }
}

function Secure-Password([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

while ($true) {
  Clear-Host
  Write-Host "====================================================" -ForegroundColor Cyan
  Write-Host " TH79 iMove Backend V6.4.1 - TOOLS" -ForegroundColor Cyan
  Write-Host "====================================================" -ForegroundColor Cyan
  Write-Host "1. npm install / cap nhat dependencies"
  Write-Host "2. Seed bang gia"
  Write-Host "3. Seed 12 tai xe demo"
  Write-Host "4. Seed 20 khach hang demo"
  Write-Host "5. Tao / cap nhat tai khoan Admin"
  Write-Host "6. Reset mat khau Admin"
  Write-Host "7. Reset mat khau Driver"
  Write-Host "8. Kiem tra quan he Database"
  Write-Host "9. Kiem tra KYC storage theo SĐT Driver"
  Write-Host "10. Mo Firewall TCP 5050 + UDP 5051 (Run as Administrator)"
  Write-Host "11. Node syntax check"
  Write-Host "12. Kiem tra GPS + Sequential Matching V5.8.2"
  Write-Host "13. Seed GPS demo cho tai xe da duyet"
    Write-Host "14. Kiem tra V6.4 Platform"
    Write-Host "15. Seed du lieu V6.4 demo"
  Write-Host "0. Thoat"
  Write-Host ""

  $choice = Read-Host "Chon"

  try {
    Ensure-NodeModules

    switch ($choice) {
      "1" {
        npm install
        Pause-TH79
      }
      "2" {
        node .\scripts\seed_fare_v1.js
        Pause-TH79
      }
      "3" {
        node .\scripts\seed_driver_demo_data_v5_6.js
        Pause-TH79
      }
      "4" {
        node .\scripts\seed_customer_demo_data_v5_6.js
        Pause-TH79
      }
      "5" {
        $phone = Read-Host "SĐT Admin [0909000099]"
        if ([string]::IsNullOrWhiteSpace($phone)) { $phone = "0909000099" }
        $email = Read-Host "Email Admin [admin@imove.vn]"
        if ([string]::IsNullOrWhiteSpace($email)) { $email = "admin@imove.vn" }
        $name = Read-Host "Ten Admin [TH79 iMove Admin]"
        if ([string]::IsNullOrWhiteSpace($name)) { $name = "TH79 iMove Admin" }

        $pw = Secure-Password "Mat khau Admin (>= 8 ky tu)"
        if ($pw.Length -lt 8) { throw "Mat khau phai co it nhat 8 ky tu." }

        try {
          $env:TH79_ADMIN_PASSWORD = $pw
          node .\scripts\create_admin_user_v5_3.js $phone $email $name
        } finally {
          $env:TH79_ADMIN_PASSWORD = $null
          $pw = $null
        }
        Pause-TH79
      }
      "6" {
        $login = Read-Host "SĐT hoac Email Admin"
        $pw1 = Secure-Password "Mat khau moi (>= 8 ky tu)"
        $pw2 = Secure-Password "Nhap lai mat khau moi"
        if ($pw1.Length -lt 8) { throw "Mat khau phai co it nhat 8 ky tu." }
        if ($pw1 -ne $pw2) { throw "Hai mat khau khong giong nhau." }

        try {
          $env:TH79_NEW_ADMIN_PASSWORD = $pw1
          node .\scripts\reset_admin_password_v5_5.js $login
        } finally {
          $env:TH79_NEW_ADMIN_PASSWORD = $null
          $pw1 = $null
          $pw2 = $null
        }
        Pause-TH79
      }
      "7" {
        $phone = Read-Host "SĐT Driver"
        $pw = Secure-Password "Mat khau moi"
        try {
          $env:TH79_DRIVER_PASSWORD = $pw
          node .\scripts\reset_driver_password.js $phone
        } finally {
          $env:TH79_DRIVER_PASSWORD = $null
          $pw = $null
        }
        Pause-TH79
      }
      "8" {
        node .\scripts\check_fix_database_relations_v5_2_1.js
        Pause-TH79
      }
      "9" {
        $phone = Read-Host "SĐT Driver [0909000001]"
        if ([string]::IsNullOrWhiteSpace($phone)) { $phone = "0909000001" }
        node .\scripts\verify_driver_kyc_storage_v5_2.js $phone
        Pause-TH79
      }
      "10" {
        $rules = @(
          @{ Name='TH79 iMove Backend TCP 5050'; Protocol='TCP'; Port=5050 },
          @{ Name='TH79 iMove Discovery UDP 5051'; Protocol='UDP'; Port=5051 }
        )
        foreach ($r in $rules) {
          $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
          if (-not $existing) {
            New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow `
              -Protocol $r.Protocol -LocalPort $r.Port -RemoteAddress LocalSubnet `
              -Profile Any | Out-Null
          } else {
            Set-NetFirewallRule -DisplayName $r.Name -Enabled True -Profile Any | Out-Null
            Set-NetFirewallRule -DisplayName $r.Name -RemoteAddress LocalSubnet | Out-Null
          }
          Write-Host "READY: $($r.Name)" -ForegroundColor Green
        }
        Pause-TH79
      }
      "11" {
        npm run check
        Pause-TH79
      }
      "12" {
        node .\scripts\check_matching_v5_8.js
        Pause-TH79
      }
      "13" {
        node .\scripts\seed_demo_driver_locations_v5_8.js
        Pause-TH79
      }
      "14" {
        node --check .\src\v64_platform.js
        if ($LASTEXITCODE -eq 0) {
          Write-Host "V6.4 Platform syntax: OK" -ForegroundColor Green
        }
        Pause-TH79
      }
      "15" {
        node .\scripts\seed_v64_demo.js
        Pause-TH79
      }
      "0" { break }
      default {
        Write-Host "Lua chon khong hop le." -ForegroundColor Yellow
        Start-Sleep -Seconds 1
      }
    }
  } catch {
    Write-Host ""
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    Pause-TH79
  }
}
