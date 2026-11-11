# Builds build\Harmony.exe on Windows. One exe, with the window's HTML/CSS/JS built in.
# Needs Rust from https://rustup.rs (the default options are fine). Windows 10/11 already has
# the WebView2 runtime the window draws with; Harmony-Setup.exe installs it where it's missing.
#
# Usage: powershell -ExecutionPolicy Bypass -File build-exe.ps1 [-Tag harmony-v0.2.14]
#   -Tag   the release tag this build is (the release workflow passes it). Without it the exe
#          is a "local build", which never auto-updates itself.
param(
  [string]$Tag = ""
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Write-Host "Rust is not installed. Install it from https://rustup.rs (pick the default options), then run this again."
  exit 1
}

Write-Host "Running Harmony's tests..."
cargo test --quiet
if ($LASTEXITCODE -ne 0) {
  Write-Host "Tests failed. Fix them before building."
  exit $LASTEXITCODE
}

$env:HARMONY_TAG = $Tag
Write-Host "Building Harmony (release)..."
cargo build --release --bin Harmony
if ($LASTEXITCODE -ne 0) {
  Write-Host "Build failed (exit $LASTEXITCODE)."
  exit $LASTEXITCODE
}
$built = Join-Path $PSScriptRoot "target\release\Harmony.exe"
if (-not (Test-Path $built)) {
  Write-Host "Build finished but $built is missing."
  exit 1
}
New-Item -ItemType Directory -Force -Path build | Out-Null
Copy-Item $built (Join-Path $PSScriptRoot "build\Harmony.exe") -Force
if ($Tag) { Write-Host "Built build\Harmony.exe as $Tag." } else { Write-Host "Built build\Harmony.exe (local build)." }
