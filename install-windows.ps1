param(
    [ValidatePattern('^[a-p]{32}$')]
    [string] $ExtensionId,
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\app.morphe.jam.chrome'

if ($Uninstall) {
    if (Test-Path -LiteralPath $registryPath) {
        Remove-Item -LiteralPath $registryPath
    }
    Write-Host 'Jam helper registration removed. Extension source files were kept.'
    return
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$nodeMajor = [int]((& $nodePath --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }
$javaPath = (Get-Command java.exe -ErrorAction Stop).Source
$processInfo = New-Object System.Diagnostics.ProcessStartInfo
$processInfo.FileName = $javaPath
$processInfo.Arguments = '-version'
$processInfo.UseShellExecute = $false
$processInfo.CreateNoWindow = $true
$processInfo.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::Start($processInfo)
$javaVersion = $process.StandardError.ReadToEnd()
$process.WaitForExit()
if ($process.ExitCode -ne 0 -or $javaVersion -notmatch 'version "(\d+)' -or [int]$Matches[1] -lt 17) {
    throw 'Java 17 or newer is required for Android-compatible short codes.'
}
$process.Dispose()
$extensionManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'extension\manifest.json') -Raw | ConvertFrom-Json
$sha = [System.Security.Cryptography.SHA256]::Create()
try { $identityHash = $sha.ComputeHash([Convert]::FromBase64String($extensionManifest.key)) } finally { $sha.Dispose() }
$stableId = -join ($identityHash[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
if (!$ExtensionId) { $ExtensionId = $stableId }
if ($ExtensionId -ne $stableId) { throw "This release's extension ID is $stableId. Reload the keyed manifest before installing." }
if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules\bonjour-service'))) {
    Push-Location $PSScriptRoot
    try {
        & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Could not install helper dependencies.' }
    } finally { Pop-Location }
}

$installationDirectory = Join-Path $PSScriptRoot 'installed'
$hostScript = Join-Path $PSScriptRoot 'native\host.mjs'
# CMD expands percent signs even inside quotes. Reject them in generated launch paths.
if (($nodePath + $hostScript + $javaPath) -match '[%"\r\n]') {
    throw 'Install paths must not contain percent signs, quotes or newlines.'
}
New-Item -ItemType Directory -Path $installationDirectory -Force | Out-Null
$launcherPath = Join-Path $installationDirectory 'jam-host.cmd'
$manifestPath = Join-Path $installationDirectory 'app.morphe.jam.chrome.json'
$launcher = "@echo off`r`nsetlocal DisableDelayedExpansion`r`nset NODE_OPTIONS=`r`nset NODE_PATH=`r`nset JAVA_TOOL_OPTIONS=`r`nset JDK_JAVA_OPTIONS=`r`nset _JAVA_OPTIONS=`r`nset `"JAM_JAVA=$javaPath`"`r`n`"$nodePath`" `"$hostScript`"`r`n"
[System.IO.File]::WriteAllText($launcherPath, $launcher, [System.Text.UTF8Encoding]::new($false))

$manifest = @{
    name = 'app.morphe.jam.chrome'
    description = 'Morphe Jam encrypted LAN transport for Chrome'
    path = $launcherPath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))
New-Item -Path $registryPath -Force | Out-Null
Set-Item -LiteralPath $registryPath -Value $manifestPath
Write-Host "Registered the Jam helper for extension $ExtensionId."
Write-Host "In chrome://extensions enable Developer mode, then Load unpacked: $(Join-Path $PSScriptRoot 'extension')"
Write-Host 'For updates, click Reload on the extension. Then reload YouTube Music.'
