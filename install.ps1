param(
  [string]$Version = "latest",
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\Luochu"
)

$ErrorActionPreference = "Stop"
if ($Version -eq "latest") {
  $base = "https://github.com/yihui/luochu/releases/latest/download"
} elseif ($Version -match '^v[0-9][A-Za-z0-9._-]*$') {
  $base = "https://github.com/yihui/luochu/releases/download/$Version"
} else {
  throw "Use a version tag such as v0.1.0-alpha.1, or omit it for the latest stable release."
}

switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
  "X64" { $arch = "amd64" }
  "Arm64" { $arch = "arm64" }
  default { throw "Unsupported architecture." }
}
$archive = "luochu-windows-$arch.zip"
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$archive" -OutFile (Join-Path $temp $archive)
  Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $temp "SHA256SUMS")
  $line = @(Get-Content (Join-Path $temp "SHA256SUMS") | Where-Object { $_ -match "^[0-9a-f]{64}  \./$([regex]::Escape($archive))$" })
  if ($line.Count -ne 1) { throw "Missing or invalid checksum for $archive." }
  $expected = $line[0].Substring(0, 64)
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $temp $archive)).Hash
  if ($actual -ne $expected) { throw "Checksum verification failed for $archive." }
  Expand-Archive -Path (Join-Path $temp $archive) -DestinationPath (Join-Path $temp "extracted")
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Force (Join-Path $temp "extracted\luochu.exe") (Join-Path $InstallDir "luochu.exe")
  Write-Host "Installed $(Join-Path $InstallDir 'luochu.exe')"
} finally {
  foreach ($file in @((Join-Path $temp $archive), (Join-Path $temp "SHA256SUMS"), (Join-Path $temp "extracted\luochu.exe"), (Join-Path $temp "extracted\README.md"))) {
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
  }
  $extracted = Join-Path $temp "extracted"
  if (Test-Path -LiteralPath $extracted) { Remove-Item -LiteralPath $extracted }
  Remove-Item -LiteralPath $temp
}
