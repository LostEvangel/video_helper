param(
    [string] $RegistryRoot = 'HKCU:\Software\Classes',
    [switch] $Install,
    [switch] $Uninstall,
    [switch] $Status,
    [string] $NotifyFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$script:ThumbnailHandlerIid = '{E357FCCD-A995-4576-B01F-234630154E96}'
$script:ManifestPath = Join-Path $PSScriptRoot 'manifest.json'

function Get-ThumbnailManifest {
    if (-not (Test-Path -LiteralPath $script:ManifestPath -PathType Leaf)) {
        throw "Thumbnail manifest was not found: $script:ManifestPath"
    }
    $manifest = Get-Content -LiteralPath $script:ManifestPath -Raw | ConvertFrom-Json
    if ($manifest.clsid -notmatch '^\{[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\}$') {
        throw 'The thumbnail manifest contains an invalid CLSID.'
    }
    if ($manifest.version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw 'The thumbnail manifest contains an unsafe version directory.'
    }
    if ($manifest.dllFile -notmatch '^[A-Za-z0-9._-]{1,128}\.dll$') {
        throw 'The thumbnail manifest contains an unsafe DLL filename.'
    }
    if ($manifest.sha256 -notmatch '^[0-9a-fA-F]{64}$') {
        throw 'The thumbnail manifest contains an invalid SHA-256 value.'
    }
    return $manifest
}

function Get-ThumbnailPayloadDll([object] $Manifest) {
    $candidates = @(
        (Join-Path $PSScriptRoot $Manifest.dllFile),
        (Join-Path (Join-Path $PSScriptRoot 'dist') $Manifest.dllFile)
    )
    $payloadRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $resolved = (Resolve-Path -LiteralPath $candidate).Path
        $fullPath = [IO.Path]::GetFullPath($resolved)
        if (-not $fullPath.StartsWith($payloadRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The thumbnail DLL resolves outside its trusted payload directory.'
        }
        return $fullPath
    }
    throw "The thumbnail DLL was not found beside the installer or in its dist folder: $($Manifest.dllFile)"
}

function Assert-ThumbnailDll([string] $Path, [object] $Manifest) {
    if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
        throw 'The optional thumbnail provider requires 64-bit Windows PowerShell on 64-bit Windows.'
    }
    $actualHash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if (-not $actualHash.Equals([string]$Manifest.sha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The thumbnail DLL SHA-256 does not match manifest.json (expected $($Manifest.sha256), found $actualHash)."
    }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
        throw 'The thumbnail DLL is not a valid PE image.'
    }
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    if ($peOffset -lt 0 -or $peOffset + 6 -gt $bytes.Length -or $bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or [BitConverter]::ToUInt16($bytes, $peOffset + 4) -ne 0x8664) {
        throw 'The thumbnail DLL is not an x64 Windows binary.'
    }
}

function ConvertTo-ClassesRootPath([string] $Path) {
    $normalized = $Path.TrimEnd('\')
    if ($normalized -ne 'HKCU:\Software\Classes' -and $normalized -notmatch '^HKCU:\\Software\\VideoHelper\.Tests\.[0-9a-fA-F]{32}$') {
        throw 'RegistryRoot must be HKCU:\Software\Classes or an isolated HKCU:\Software\VideoHelper.Tests.<guid> test root; machine-wide and other registry roots are not allowed.'
    }
    return $normalized
}

function Assert-ThumbnailRegistryPath([string] $Path) {
    $normalized = $Path.TrimEnd('\')
    if ($normalized -notmatch '^HKCU:\\Software\\Classes(?:\\[A-Za-z0-9 ._{}-]+)*$' -and $normalized -notmatch '^HKCU:\\Software\\VideoHelper\.Tests\.[0-9a-fA-F]{32}(?:\\[A-Za-z0-9 ._{}-]+)*$') {
        throw 'A thumbnail registry path resolved outside its approved per-user registry root.'
    }
    return $normalized
}

function Get-ThumbnailInstallDirectory([object] $Manifest) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) {
        throw 'Windows did not provide an absolute Local AppData directory.'
    }
    $basePath = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'VideoHelper\ThumbnailProvider'))
    $directory = [IO.Path]::GetFullPath((Join-Path $basePath $Manifest.version))
    $basePrefix = $basePath.TrimEnd('\') + '\'
    if (-not $directory.StartsWith($basePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The computed plugin installation path is outside Local AppData.'
    }
    return $directory
}

function Get-RegistrySubKey([string] $Path) {
    $normalized = Assert-ThumbnailRegistryPath $Path
    return $normalized.Substring('HKCU:\'.Length).Replace('\', '\')
}

function Get-ThumbnailRegistryValue([string] $Path, [string] $Name) {
    $subKey = Get-RegistrySubKey $Path
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey, $false)
    if ($null -eq $key) {
        return [pscustomobject]@{ keyExists = $false; exists = $false; kind = $null; data = $null }
    }
    try {
        $exists = @($key.GetValueNames()) -contains $Name
        if (-not $exists) {
            return [pscustomobject]@{ keyExists = $true; exists = $false; kind = $null; data = $null }
        }
        $kind = $key.GetValueKind($Name)
        $data = $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($kind -eq [Microsoft.Win32.RegistryValueKind]::Binary) {
            $data = [Convert]::ToBase64String([byte[]]$data)
        }
        return [pscustomobject]@{ keyExists = $true; exists = $true; kind = $kind.ToString(); data = $data }
    }
    finally {
        $key.Dispose()
    }
}

function Write-ThumbnailRegistryValue([string] $Path, [string] $Name, [object] $Value, [string] $Kind = 'String') {
    $subKey = Get-RegistrySubKey $Path
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subKey)
    if ($null -eq $key) { throw "Could not create registry key: $Path" }
    try {
        $registryKind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $Kind, $true)
        switch ($registryKind) {
            ([Microsoft.Win32.RegistryValueKind]::Binary) { $Value = [Convert]::FromBase64String([string]$Value); break }
            ([Microsoft.Win32.RegistryValueKind]::DWord) { $Value = [int]$Value; break }
            ([Microsoft.Win32.RegistryValueKind]::QWord) { $Value = [long]$Value; break }
            ([Microsoft.Win32.RegistryValueKind]::MultiString) { $Value = [string[]]@($Value); break }
            default { $Value = [string]$Value; break }
        }
        $key.SetValue($Name, $Value, $registryKind)
    }
    finally {
        $key.Dispose()
    }
}

function Set-ThumbnailRegistryValue([string] $Path, [string] $Name, [object] $Value, [string] $Kind = 'String') {
    Write-ThumbnailRegistryValue -Path $Path -Name $Name -Value $Value -Kind $Kind
}

function Remove-ThumbnailRegistryValue([string] $Path, [string] $Name) {
    $subKey = Get-RegistrySubKey $Path
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey, $true)
    if ($null -eq $key) { return }
    try { $key.DeleteValue($Name, $false) }
    finally { $key.Dispose() }
}

function Remove-ThumbnailEmptyKey([string] $Path) {
    $normalized = Assert-ThumbnailRegistryPath $Path
    $subKey = Get-RegistrySubKey $normalized
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey, $false)
    if ($null -eq $key) { return }
    try {
        $empty = @($key.GetValueNames()).Count -eq 0 -and @($key.GetSubKeyNames()).Count -eq 0
    }
    finally { $key.Dispose() }
    if (-not $empty) { return }
    $slash = $subKey.LastIndexOf('\')
    if ($slash -lt 0) { return }
    $parent = $subKey.Substring(0, $slash)
    $child = $subKey.Substring($slash + 1)
    $parentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($parent, $true)
    if ($null -eq $parentKey) { return }
    try { $parentKey.DeleteSubKey($child, $false) }
    finally { $parentKey.Dispose() }
}

function ConvertTo-BackupValue([object] $Value) {
    return [ordered]@{
        keyExists = [bool]$Value.keyExists
        exists = [bool]$Value.exists
        kind = $Value.kind
        data = $Value.data
    }
}

function Restore-ThumbnailRegistryValue([string] $Path, [string] $Name, [object] $Backup) {
    if ($Backup.exists) {
        Set-ThumbnailRegistryValue -Path $Path -Name $Name -Value $Backup.data -Kind $Backup.kind
    }
    else {
        Remove-ThumbnailRegistryValue -Path $Path -Name $Name
        if (-not $Backup.keyExists) { Remove-ThumbnailEmptyKey $Path }
    }
}

function Write-ThumbnailBackup([string] $Path, [object] $Backup) {
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    $json = ConvertTo-Json -InputObject $Backup -Depth 8 -Compress
    try {
        [IO.File]::WriteAllText($temporary, $json, (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Read-ThumbnailBackup([string] $Path, [string] $Root, [object] $Manifest) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $json = Get-Content -LiteralPath $Path -Raw
    if ($json.Length -gt 64KB) { throw 'The saved thumbnail registration backup is unexpectedly large.' }
    $backup = $json | ConvertFrom-Json
    if ($backup.schema -ne 1 -or $backup.clsid -ne $Manifest.clsid -or $backup.registryRoot -ne $Root -or $null -eq $backup.handler -or $null -eq $backup.comServer -or $null -eq $backup.comThreadingModel) {
        throw 'The saved thumbnail registration backup does not match this installation.'
    }
    return $backup
}

function Get-ThumbnailPaths([string] $Root, [object] $Manifest) {
    $installDirectory = Get-ThumbnailInstallDirectory $Manifest
    $dllPath = Join-Path $installDirectory $Manifest.dllFile
    $classPath = Join-Path $Root "CLSID\$($Manifest.clsid)\InprocServer32"
    $handlerPath = Join-Path $Root ".mp4\ShellEx\$script:ThumbnailHandlerIid"
    $backupPath = Join-Path $installDirectory 'registration-backup.json'
    $deferredPath = Join-Path $installDirectory 'cleanup-pending.json'
    return [pscustomobject]@{
        installDirectory = $installDirectory
        dllPath = [IO.Path]::GetFullPath($dllPath)
        classPath = $classPath
        handlerPath = $handlerPath
        backupPath = $backupPath
        deferredPath = $deferredPath
    }
}

function Test-ThumbnailCurrentClass([string] $Path, [object] $Manifest) {
    $classServer = Get-ThumbnailRegistryValue $Path ''
    if (-not $classServer.exists -or $classServer.kind -ne 'String') { return $false }
    $installedDll = Get-ThumbnailInstallDirectory $Manifest
    $installedDll = [IO.Path]::GetFullPath((Join-Path $installedDll $Manifest.dllFile))
    return ([IO.Path]::GetFullPath([string]$classServer.data)).Equals($installedDll, [StringComparison]::OrdinalIgnoreCase)
}

function Get-ThumbnailEffectiveHandler([string] $Root, [object] $Manifest, [object] $Paths) {
    if ($Root -eq 'HKCU:\Software\Classes') {
        $registryPath = 'Registry::HKEY_CLASSES_ROOT' + "\.mp4\ShellEx\$script:ThumbnailHandlerIid"
        $key = Get-Item -LiteralPath $registryPath -ErrorAction SilentlyContinue
        if ($null -eq $key) { return $null }
        try {
            if (@($key.GetValueNames()) -notcontains '') { return $null }
            return [string]$key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        }
        finally { $key.Dispose() }
    }
    $value = Get-ThumbnailRegistryValue $Paths.handlerPath ''
    if (-not $value.exists) { return $null }
    return [string]$value.data
}

function Get-ThumbnailEffectiveComRegistration([string] $Root, [object] $Manifest, [object] $Paths) {
    if ($Root -eq 'HKCU:\Software\Classes') {
        $registryPath = 'Registry::HKEY_CLASSES_ROOT' + "\CLSID\$($Manifest.clsid)\InprocServer32"
        $key = Get-Item -LiteralPath $registryPath -ErrorAction SilentlyContinue
        if ($null -eq $key) { return $null }
        try {
            $serverExists = @($key.GetValueNames()) -contains ''
            $threadingExists = @($key.GetValueNames()) -contains 'ThreadingModel'
            return [pscustomobject]@{
                server = if ($serverExists) { [string]$key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
                threadingModel = if ($threadingExists) { [string]$key.GetValue('ThreadingModel', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
            }
        }
        finally { $key.Dispose() }
    }
    $server = Get-ThumbnailRegistryValue $paths.classPath ''
    $threading = Get-ThumbnailRegistryValue $paths.classPath 'ThreadingModel'
    return [pscustomobject]@{
        server = if ($server.exists) { [string]$server.data } else { $null }
        threadingModel = if ($threading.exists) { [string]$threading.data } else { $null }
    }
}

function Get-ThumbnailStatus([string] $RegistryRoot) {
    $root = ConvertTo-ClassesRootPath $RegistryRoot
    $manifest = Get-ThumbnailManifest
    $paths = Get-ThumbnailPaths $root $manifest
    $installed = Test-ThumbnailCurrentClass $paths.classPath $manifest
    $effectiveHandler = Get-ThumbnailEffectiveHandler $root $manifest $paths
    $effectiveClass = Get-ThumbnailEffectiveComRegistration $root $manifest $paths
    $classMatches = $null -ne $effectiveClass -and $null -ne $effectiveClass.server -and [IO.Path]::IsPathRooted([string]$effectiveClass.server)
    if ($classMatches) { $classMatches = ([IO.Path]::GetFullPath([string]$effectiveClass.server)).Equals($paths.dllPath, [StringComparison]::OrdinalIgnoreCase) }
    $classReady = $classMatches -and $effectiveClass.threadingModel -eq 'Apartment'
    $handlerMatches = $null -ne $effectiveHandler -and $effectiveHandler.Equals([string]$manifest.clsid, [StringComparison]::OrdinalIgnoreCase)
    $active = $installed -and $handlerMatches -and $classReady
    $handlerConflict = $null -ne $effectiveHandler -and $effectiveHandler.Length -gt 0 -and -not $handlerMatches
    $classConflict = $handlerMatches -and $null -ne $effectiveClass -and -not $classReady
    $conflict = $installed -and ($handlerConflict -or $classConflict)
    if ($active) {
        $message = '缩略图插件已安装，且当前是 Windows 使用的 MP4 缩略图处理器。'
    }
    elseif ($conflict) {
        $message = '缩略图插件已安装，但 Windows 当前使用其他 MP4 缩略图处理器；此插件尚未生效。'
    }
    elseif ($installed) {
        $message = '缩略图插件已注册；Windows 尚未将其设为当前的 MP4 缩略图处理器。'
    }
    else {
        $message = '缩略图插件尚未安装。'
    }
    return [pscustomobject]@{
        installed = [bool]$installed
        active = [bool]$active
        conflict = [bool]$conflict
        cleanupDeferred = [bool](Test-Path -LiteralPath $paths.deferredPath -PathType Leaf)
        version = [string]$manifest.version
        message = $message
    }
}

function Invoke-ThumbnailShellChange([string] $FilePath) {
    $typeName = 'VideoHelperThumbnailShellChange'
    if (-not ("$typeName" -as [type])) {
        $signature = @'
using System;
using System.Runtime.InteropServices;
public static class VideoHelperThumbnailShellChange
{
    [DllImport("shell32.dll", PreserveSig = false)]
    public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
        Add-Type -TypeDefinition $signature -ErrorAction Stop
    }
    if ([string]::IsNullOrWhiteSpace($FilePath)) {
        [VideoHelperThumbnailShellChange]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
        return
    }
    if (-not [IO.Path]::IsPathRooted($FilePath)) { throw 'NotifyFile must be an absolute filesystem path.' }
    $resolved = [IO.Path]::GetFullPath($FilePath)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "The file to refresh does not exist: $resolved" }
    $pathPointer = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($resolved)
    try { [VideoHelperThumbnailShellChange]::SHChangeNotify(0x00002000, 0x0005, $pathPointer, [IntPtr]::Zero) }
    finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($pathPointer) }
}

function Invoke-ThumbnailInstall([string] $RegistryRoot = 'HKCU:\Software\Classes', [scriptblock] $RegistryWriteAction = $null) {
    $root = ConvertTo-ClassesRootPath $RegistryRoot
    $manifest = Get-ThumbnailManifest
    $payloadDll = Get-ThumbnailPayloadDll $manifest
    Assert-ThumbnailDll $payloadDll $manifest
    $paths = Get-ThumbnailPaths $root $manifest
    $null = New-Item -ItemType Directory -Path $paths.installDirectory -Force
    $destinationRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'VideoHelper\ThumbnailProvider')).TrimEnd('\') + '\'
    if (-not $paths.dllPath.StartsWith($destinationRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The destination DLL path is outside Local AppData.'
    }
    if (Test-Path -LiteralPath $paths.dllPath -PathType Leaf) {
        $currentHash = (Get-FileHash -LiteralPath $paths.dllPath -Algorithm SHA256).Hash
        if (-not $currentHash.Equals([string]$manifest.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'A different file already occupies this versioned plugin DLL path; it was left untouched.'
        }
    }
    else {
        Copy-Item -LiteralPath $payloadDll -Destination $paths.dllPath
        $copiedHash = (Get-FileHash -LiteralPath $paths.dllPath -Algorithm SHA256).Hash
        if (-not $copiedHash.Equals([string]$manifest.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $paths.dllPath -Force -ErrorAction SilentlyContinue
            throw 'The copied thumbnail DLL failed its SHA-256 verification.'
        }
    }

    $currentHandler = Get-ThumbnailRegistryValue $paths.handlerPath ''
    $currentServer = Get-ThumbnailRegistryValue $paths.classPath ''
    $currentThreading = Get-ThumbnailRegistryValue $paths.classPath 'ThreadingModel'
    $currentServerIsOurs = $false
    if ($currentServer.exists -and $currentServer.kind -eq 'String') {
        try {
            $currentServerIsOurs = ([IO.Path]::GetFullPath([string]$currentServer.data)).Equals($paths.dllPath, [StringComparison]::OrdinalIgnoreCase)
        }
        catch { $currentServerIsOurs = $false }
    }
    if ($currentServer.exists -and -not $currentServerIsOurs) {
        throw 'The plugin CLSID is already registered to another server; the existing registration was left untouched.'
    }

    $handlerIsOurs = $currentHandler.exists -and $currentHandler.kind -eq 'String' -and ([string]$currentHandler.data).Equals([string]$manifest.clsid, [StringComparison]::OrdinalIgnoreCase)
    if ($handlerIsOurs) {
        $savedBackup = Read-ThumbnailBackup $paths.backupPath $root $manifest
        if ($null -eq $savedBackup) {
            throw 'The thumbnail handler already points to this CLSID, but its original-registration backup is missing; refusing to replace that history.'
        }
    }
    else {
        $savedBackup = [ordered]@{
            schema = 1
            clsid = [string]$manifest.clsid
            version = [string]$manifest.version
            registryRoot = $root
            handler = ConvertTo-BackupValue $currentHandler
            comServer = if ($currentServerIsOurs) { [ordered]@{ keyExists = $false; exists = $false; kind = $null; data = $null } } else { ConvertTo-BackupValue $currentServer }
            comThreadingModel = if ($currentServerIsOurs) { [ordered]@{ keyExists = $false; exists = $false; kind = $null; data = $null } } else { ConvertTo-BackupValue $currentThreading }
        }
    }

    $operationBefore = [ordered]@{
        handler = ConvertTo-BackupValue $currentHandler
        comServer = ConvertTo-BackupValue $currentServer
        comThreadingModel = ConvertTo-BackupValue $currentThreading
    }
    if (-not $handlerIsOurs) { Write-ThumbnailBackup $paths.backupPath $savedBackup }
    $registrationChanged = $false
    try {
        if ($null -eq $RegistryWriteAction) { Set-ThumbnailRegistryValue -Path $paths.classPath -Name '' -Value $paths.dllPath -Kind 'String' }
        else { & $RegistryWriteAction -Path $paths.classPath -Name '' -Value $paths.dllPath -Kind 'String' }
        $registrationChanged = $true
        if ($null -eq $RegistryWriteAction) { Set-ThumbnailRegistryValue -Path $paths.classPath -Name 'ThreadingModel' -Value 'Apartment' -Kind 'String' }
        else { & $RegistryWriteAction -Path $paths.classPath -Name 'ThreadingModel' -Value 'Apartment' -Kind 'String' }
        if ($null -eq $RegistryWriteAction) { Set-ThumbnailRegistryValue -Path $paths.handlerPath -Name '' -Value ([string]$manifest.clsid) -Kind 'String' }
        else { & $RegistryWriteAction -Path $paths.handlerPath -Name '' -Value ([string]$manifest.clsid) -Kind 'String' }
        $registrationChanged = $true
        if ($root -eq 'HKCU:\Software\Classes') { Invoke-ThumbnailShellChange '' }
        if (Test-Path -LiteralPath $paths.deferredPath) { Remove-Item -LiteralPath $paths.deferredPath -Force }
    }
    catch {
        $registrationError = $_.Exception.Message
        try {
            Restore-ThumbnailRegistryValue $paths.classPath '' $operationBefore.comServer
            Restore-ThumbnailRegistryValue $paths.classPath 'ThreadingModel' $operationBefore.comThreadingModel
            Restore-ThumbnailRegistryValue $paths.handlerPath '' $operationBefore.handler
            Remove-ThumbnailEmptyKey $paths.handlerPath
            Remove-ThumbnailEmptyKey $paths.classPath
            if ($registrationChanged -and $root -eq 'HKCU:\Software\Classes') { Invoke-ThumbnailShellChange '' }
        }
        catch {
            $rollbackError = $_.Exception.Message
            throw "Registration failed and rollback also failed. Original error: $registrationError. Rollback error: $rollbackError"
        }
        if (-not $handlerIsOurs) { Remove-Item -LiteralPath $paths.backupPath -Force -ErrorAction SilentlyContinue }
        throw
    }
    return Get-ThumbnailStatus $root
}

function Invoke-ThumbnailUninstall([string] $RegistryRoot = 'HKCU:\Software\Classes') {
    $root = ConvertTo-ClassesRootPath $RegistryRoot
    $manifest = Get-ThumbnailManifest
    $paths = Get-ThumbnailPaths $root $manifest
    $backup = Read-ThumbnailBackup $paths.backupPath $root $manifest
    $currentHandler = Get-ThumbnailRegistryValue $paths.handlerPath ''
    $handlerIsOurs = $currentHandler.exists -and $currentHandler.kind -eq 'String' -and ([string]$currentHandler.data).Equals([string]$manifest.clsid, [StringComparison]::OrdinalIgnoreCase)
    $handlerRestored = $false
    $comRemoved = $false
    if ($handlerIsOurs) {
        if ($null -eq $backup) { throw 'The current handler points to this CLSID, but its original-registration backup is missing; refusing to remove it.' }
        Restore-ThumbnailRegistryValue $paths.handlerPath '' $backup.handler
        Remove-ThumbnailEmptyKey $paths.handlerPath
        $handlerRestored = $true
    }

    $currentServer = Get-ThumbnailRegistryValue $paths.classPath ''
    $serverIsOurs = $false
    if ($currentServer.exists -and $currentServer.kind -eq 'String') {
        try {
            $serverIsOurs = ([IO.Path]::GetFullPath([string]$currentServer.data)).Equals($paths.dllPath, [StringComparison]::OrdinalIgnoreCase)
        }
        catch { $serverIsOurs = $false }
    }
    if ($serverIsOurs) {
        if ($null -ne $backup) {
            Restore-ThumbnailRegistryValue $paths.classPath '' $backup.comServer
            Restore-ThumbnailRegistryValue $paths.classPath 'ThreadingModel' $backup.comThreadingModel
        }
        else {
            Remove-ThumbnailRegistryValue $paths.classPath ''
            Remove-ThumbnailRegistryValue $paths.classPath 'ThreadingModel'
        }
        Remove-ThumbnailEmptyKey $paths.classPath
        Remove-ThumbnailEmptyKey (Join-Path $root "CLSID\$($manifest.clsid)")
        $comRemoved = $true
    }
    if (($handlerRestored -or $comRemoved) -and $root -eq 'HKCU:\Software\Classes') { Invoke-ThumbnailShellChange '' }
    if (Test-Path -LiteralPath $paths.backupPath) { Remove-Item -LiteralPath $paths.backupPath -Force }

    $cleanupDeferred = $false
    if (Test-Path -LiteralPath $paths.dllPath -PathType Leaf) {
        try {
            Remove-Item -LiteralPath $paths.dllPath -Force
        }
        catch {
            $cleanupDeferred = $true
            [IO.File]::WriteAllText($paths.deferredPath, 'The thumbnail DLL was still in use when uninstalled.', (New-Object System.Text.UTF8Encoding($false)))
        }
    }
    if (-not $cleanupDeferred -and (Test-Path -LiteralPath $paths.deferredPath)) { Remove-Item -LiteralPath $paths.deferredPath -Force }
    if (-not $cleanupDeferred -and (Test-Path -LiteralPath $paths.installDirectory -PathType Container)) {
        try { Remove-Item -LiteralPath $paths.installDirectory -Force -ErrorAction Stop }
        catch { $cleanupDeferred = $true }
    }
    $status = Get-ThumbnailStatus $root
    if ($cleanupDeferred) {
        return [pscustomobject]@{
            installed = [bool]$status.installed
            active = [bool]$status.active
            conflict = [bool]$status.conflict
            cleanupDeferred = $true
            version = [string]$manifest.version
            message = '缩略图插件已取消注册；DLL 仍在使用中，稍后可删除 Local AppData 中的插件文件。'
        }
    }
    $laterHandlerOwnsKey = $currentHandler.exists -and (@('String', 'ExpandString') -contains [string]$currentHandler.kind) -and -not [string]::IsNullOrEmpty([string]$currentHandler.data) -and -not $handlerIsOurs
    if ($laterHandlerOwnsKey) {
        $status.conflict = $true
        $status | Add-Member -NotePropertyName message -NotePropertyValue '其他处理器已接管 MP4 缩略图；卸载时保留了当前注册。' -Force
    }
    return $status
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $root = ConvertTo-ClassesRootPath $RegistryRoot
        $actionCount = 0
        if ($Install) { $actionCount++ }
        if ($Uninstall) { $actionCount++ }
        if ($Status) { $actionCount++ }
        if (-not [string]::IsNullOrEmpty($NotifyFile)) { $actionCount++ }
        if ($actionCount -gt 1) { throw 'Choose only one installer action.' }
        if ($Status) {
            Get-ThumbnailStatus $root | ConvertTo-Json -Compress -Depth 6 | Write-Output
            exit 0
        }
        if (-not [string]::IsNullOrEmpty($NotifyFile)) {
            Invoke-ThumbnailShellChange $NotifyFile
            [pscustomobject]@{ ok = $true; action = 'notify-file' } | ConvertTo-Json -Compress | Write-Output
            exit 0
        }
        if ($Uninstall) {
            Invoke-ThumbnailUninstall $root | ConvertTo-Json -Compress -Depth 6 | Write-Output
            exit 0
        }
        Get-ThumbnailStatus $root | Out-Null
        Invoke-ThumbnailInstall $root | ConvertTo-Json -Compress -Depth 6 | Write-Output
        exit 0
    }
    catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
