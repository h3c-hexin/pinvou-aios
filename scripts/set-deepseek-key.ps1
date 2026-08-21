$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$envPath = Join-Path $root ".env"
$examplePath = Join-Path $root ".env.example"

if (-not (Test-Path -LiteralPath $envPath)) {
  Copy-Item -LiteralPath $examplePath -Destination $envPath
}

$secure = Read-Host "Paste DeepSeek API key" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if (-not $key -or -not $key.Trim()) {
  throw "DEEPSEEK_API_KEY cannot be empty."
}

$lines = Get-Content -LiteralPath $envPath -ErrorAction SilentlyContinue
$updated = $false
$next = foreach ($line in $lines) {
  if ($line -match '^DEEPSEEK_API_KEY=') {
    $updated = $true
    "DEEPSEEK_API_KEY=$($key.Trim())"
  }
  else {
    $line
  }
}

if (-not $updated) {
  $next += "DEEPSEEK_API_KEY=$($key.Trim())"
}

Set-Content -LiteralPath $envPath -Value $next -Encoding UTF8
Write-Host "DeepSeek API key saved to .env"
Start-Sleep -Seconds 2
