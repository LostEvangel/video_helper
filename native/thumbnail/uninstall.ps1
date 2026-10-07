param(
    [string] $RegistryRoot = 'HKCU:\Software\Classes'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($MyInvocation.InvocationName -ne '.') {
    $installer = Join-Path $PSScriptRoot 'install.ps1'
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        [Console]::Error.WriteLine('The companion install.ps1 script was not found.')
        exit 1
    }
    & $installer -RegistryRoot $RegistryRoot -Uninstall
}
