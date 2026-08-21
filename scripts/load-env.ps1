param(
  [string]$EnvPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) ".env")
)

if (-not (Test-Path -LiteralPath $EnvPath)) {
  return
}

Get-Content -LiteralPath $EnvPath | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) {
    return
  }

  $equals = $line.IndexOf("=")
  if ($equals -le 0) {
    return
  }

  $name = $line.Substring(0, $equals).Trim()
  $value = $line.Substring($equals + 1).Trim()

  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }

  [Environment]::SetEnvironmentVariable($name, $value, "Process")
}
