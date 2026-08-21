$ErrorActionPreference = "Stop"

. "$PSScriptRoot\load-env.ps1"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")

if (-not $env:PINVOU_AIOS_TCP_ADDR) {
  $env:PINVOU_AIOS_TCP_ADDR = "127.0.0.1:57931"
}

$env:PINVOU_ELECTRON_NO_SANDBOX = "1"

Push-Location (Join-Path $root "apps\pad-ui")
try {
  npm run electron
}
finally {
  Pop-Location
}
