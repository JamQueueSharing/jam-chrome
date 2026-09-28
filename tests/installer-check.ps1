$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$hiddenParent = Join-Path $root ('test-output\hidden-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $hiddenParent -Force | Out-Null
[IO.File]::SetAttributes($hiddenParent, [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::Hidden)
$installRoot = Join-Path $hiddenParent 'JamChrome'
$archive = Join-Path $root 'dist\jam-chrome-0.2.1-windows.zip'
$bootstrap = Join-Path $root 'install.ps1'
$registry = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\app.morphe.jam.chrome'
$previous = if (Test-Path -LiteralPath $registry) { (Get-Item -LiteralPath $registry).GetValue('') } else { $null }
try {
    & $bootstrap -InstallRoot $installRoot -ArchivePath $archive -SkipPrerequisites
    $current = Join-Path $installRoot 'current'
    $before = (Get-FileHash -LiteralPath (Join-Path $current 'extension\manifest.json')).Hash
    $registration = (Get-Item -LiteralPath $registry).GetValue('')
    & $bootstrap -InstallRoot $installRoot -ArchivePath $archive -SkipPrerequisites
    if (!(Get-ChildItem -LiteralPath $installRoot -Directory -Filter 'backup-*')) { throw 'Update did not retain a backup.' }
    $rejected = $false
    try { & $bootstrap -InstallRoot $installRoot -ArchivePath (Join-Path $root 'README.md') -SkipPrerequisites }
    catch { $rejected = $_.Exception.Message -like '*checksum mismatch*' }
    if (!$rejected) { throw 'Modified archive was not rejected.' }

    # Simulate a missing runtime after extraction to exercise transaction rollback.
    $oldPath = $env:PATH
    $rolledBack = $false
    try {
        $env:PATH = ''
        & $bootstrap -InstallRoot $installRoot -ArchivePath $archive -SkipPrerequisites
    } catch { $rolledBack = $true }
    finally { $env:PATH = $oldPath }
    if (!$rolledBack) { throw 'Expected registration failure was not observed.' }
    if ((Get-FileHash -LiteralPath (Join-Path $current 'extension\manifest.json')).Hash -ne $before) { throw 'Previous files were not restored.' }
    if ((Get-Item -LiteralPath $registry).GetValue('') -ne $registration) { throw 'Previous registration was not restored.' }
    Write-Host 'Hidden-parent install, update backup, corrupt archive rejection and rollback: passed.'
} finally {
    if ($null -ne $previous) {
        New-Item -Path $registry -Force | Out-Null
        Set-Item -LiteralPath $registry -Value $previous
    } elseif (Test-Path -LiteralPath $registry) { Remove-Item -LiteralPath $registry }
}
