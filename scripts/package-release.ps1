param([string] $Version = '0.2.0')
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid version.' }
$root = Split-Path $PSScriptRoot -Parent
$distribution = Join-Path $root 'dist'
$stage = Join-Path $distribution ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($name in @('extension', 'native', 'package.json', 'package-lock.json', 'install-windows.ps1', 'README.md', 'SECURITY.md')) {
    Copy-Item -LiteralPath (Join-Path $root $name) -Destination $stage -Recurse
}
Push-Location $stage
try {
    & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Release dependency installation failed.' }
} finally { Pop-Location }
$archive = Join-Path $distribution "jam-chrome-$Version-windows.zip"
if (Test-Path -LiteralPath $archive) { throw "Archive already exists: $archive" }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $archive)
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText((Join-Path $distribution 'SHA256SUMS'), "$hash  $(Split-Path $archive -Leaf)`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "SHA256: $hash"
Write-Host "Archive: $archive"
