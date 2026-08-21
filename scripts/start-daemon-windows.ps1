$ErrorActionPreference = "Stop"

. "$PSScriptRoot\load-env.ps1"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")

if (-not $env:DEEPSEEK_API_KEY) {
  throw "DEEPSEEK_API_KEY is missing. Copy .env.example to .env and fill it first."
}

if (-not $env:DEEPSEEK_BASE_URL) {
  $env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"
}

if (-not $env:PINVOU_PI_MODEL) {
  $env:PINVOU_PI_MODEL = "deepseek-v4-flash"
}

if (-not $env:PINVOU_AIOS_TCP_ADDR) {
  $env:PINVOU_AIOS_TCP_ADDR = "127.0.0.1:57931"
}

$node = Get-Command node -ErrorAction Stop
$env:PINVOU_PI_BIN = $node.Source
$env:PINVOU_PI_SCRIPT = Join-Path $PSScriptRoot "deepseek-pi.mjs"
$env:PINVOU_PI_PROVIDER = "deepseek"

Push-Location (Join-Path $root "daemon")
try {
  cargo run
}
finally {
  Pop-Location
}
