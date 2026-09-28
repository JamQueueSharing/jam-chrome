param(
    [string] $InstallRoot = (Join-Path $env:LOCALAPPDATA 'JamQueueSharing\JamChrome'),
    [string] $ArchivePath,
    [switch] $SkipPrerequisites
)
$ErrorActionPreference = 'Stop'
$version = '0.2.1'
$expectedHash = 'facd964f74cc673c6bf28ca4378eb627be645a1f81ad8c5bef224285f766b174'
$archiveName = "jam-chrome-$version-windows.zip"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Assert-Child([string] $Path, [string] $Parent) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    if (!$absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Path escapes installation directory: $Path" }
    return $absolute
}

function Install-Prerequisite([string] $Command, [string] $Package) {
    if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
    if (!(Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22+ and Java 17+, or Windows App Installer (winget), then retry.' }
    Write-Host "Installing $Package through winget; Windows may request approval."
    & winget.exe install --id $Package --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) { throw "Could not install $Package. Install it manually and retry." }
    $env:PATH = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
if ($InstallRoot -match '[%"\r\n]') { throw 'Unsupported installation path.' }
# Reject junctions before writing or moving any installation files.
$ancestor = $InstallRoot
while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation paths must not be links or junctions.' }
    $ancestor = Split-Path $ancestor -Parent
}
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
$stage = Assert-Child (Join-Path $InstallRoot ('staging-' + [guid]::NewGuid().ToString('N'))) $InstallRoot
New-Item -ItemType Directory -Path $stage | Out-Null
if (!$ArchivePath) {
    $ArchivePath = Join-Path $stage $archiveName
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/JamQueueSharing/jam-chrome/releases/download/v$version/$archiveName" -OutFile $ArchivePath
}
$hash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $expectedHash) { throw 'Release checksum mismatch. Nothing was installed.' }

$payload = Join-Path $stage 'payload'
New-Item -ItemType Directory -Path $payload | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($ArchivePath))
try {
    $total = 0L
    foreach ($entry in $zip.Entries) {
        if ($entry.FullName.Contains(':') -or $entry.FullName.Contains('\') -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Unsafe release archive entry.' }
        $null = Assert-Child (Join-Path $payload $entry.FullName) $payload
        $total += $entry.Length
        if ($total -gt 250MB -or $zip.Entries.Count -gt 20000) { throw 'Release archive exceeds installation limits.' }
    }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($ArchivePath), $payload)
if (!$SkipPrerequisites) {
    Install-Prerequisite 'node.exe' 'OpenJS.NodeJS.LTS'
    Install-Prerequisite 'java.exe' 'EclipseAdoptium.Temurin.21.JRE'
}

$current = Assert-Child (Join-Path $InstallRoot 'current') $InstallRoot
$backup = Assert-Child (Join-Path $InstallRoot ('backup-' + [guid]::NewGuid().ToString('N'))) $InstallRoot
if ((Test-Path -LiteralPath $current) -and ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Current installation must not be a link or junction.' }
$registry = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\app.morphe.jam.chrome'
$previousRegistration = if (Test-Path -LiteralPath $registry) { (Get-Item -LiteralPath $registry).GetValue('') } else { $null }
$hadCurrent = Test-Path -LiteralPath $current
if ($hadCurrent) { Move-Item -LiteralPath $current -Destination $backup }
try {
    Move-Item -LiteralPath $payload -Destination $current
    & (Join-Path $current 'install-windows.ps1')
} catch {
    # Retain failed files for diagnosis, then restore the previous installation.
    if (Test-Path -LiteralPath $current) { Move-Item -LiteralPath $current -Destination (Assert-Child (Join-Path $stage 'failed') $InstallRoot) }
    if ($hadCurrent) { Move-Item -LiteralPath $backup -Destination $current }
    if ($null -ne $previousRegistration) {
        New-Item -Path $registry -Force | Out-Null
        Set-Item -LiteralPath $registry -Value $previousRegistration
    } elseif (Test-Path -LiteralPath $registry) { Remove-Item -LiteralPath $registry }
    throw
}
Write-Host "Installed Jam Chrome $version. Older versions are retained in backup folders under $InstallRoot."
