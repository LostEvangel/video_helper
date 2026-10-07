$ErrorActionPreference = 'Stop'

Describe 'Video Helper thumbnail registration' {
    BeforeEach {
        $script:previousLocalAppData = $env:LOCALAPPDATA
        $script:testId = [Guid]::NewGuid().ToString('N')
        $script:testClassesRoot = "HKCU:\Software\VideoHelper.Tests.$($script:testId)"
        $script:testDataRoot = Join-Path $PSScriptRoot ".registration-$($script:testId)"
        $script:testLocalAppData = Join-Path $script:testDataRoot 'LocalAppData'
        [void](New-Item -ItemType Directory -Path $script:testLocalAppData -Force)
        $env:LOCALAPPDATA = $script:testLocalAppData
        $script:installScript = Join-Path (Split-Path $PSScriptRoot -Parent) 'install.ps1'
        $script:uninstallScript = Join-Path (Split-Path $PSScriptRoot -Parent) 'uninstall.ps1'
        . $script:installScript
        . $script:uninstallScript
        $script:handlerPath = Join-Path $script:testClassesRoot '.mp4\ShellEx\{E357FCCD-A995-4576-B01F-234630154E96}'
    }

    AfterEach {
        $env:LOCALAPPDATA = $script:previousLocalAppData
        if (Test-Path -LiteralPath $script:testClassesRoot) {
            Remove-Item -LiteralPath $script:testClassesRoot -Recurse -Force
        }
        if (Test-Path -LiteralPath $script:testDataRoot) {
            Remove-Item -LiteralPath $script:testDataRoot -Recurse -Force
        }
    }

    It 'installs from an empty handler and restores the missing value on uninstall' {
        $installed = Invoke-ThumbnailInstall -RegistryRoot $script:testClassesRoot

        $installed.installed | Should Be $true
        $installed.active | Should Be $true
        $handler = Get-Item -LiteralPath $script:handlerPath
        $handler.GetValue('') | Should Be '{c74c4f7e-ec39-44e4-9daa-78d6509384eb}'

        $removed = Invoke-ThumbnailUninstall -RegistryRoot $script:testClassesRoot
        $removed.installed | Should Be $false
        (Test-Path -LiteralPath $script:handlerPath) | Should Be $false
    }

    It 'restores an existing empty default string exactly' {
        [void](New-Item -Path $script:handlerPath -Force)
        Set-Item -LiteralPath $script:handlerPath -Value ''

        [void](Invoke-ThumbnailInstall -RegistryRoot $script:testClassesRoot)
        [void](Invoke-ThumbnailUninstall -RegistryRoot $script:testClassesRoot)

        $after = Get-Item -LiteralPath $script:handlerPath
        @($after.GetValueNames()) -contains '' | Should Be $true
        $after.GetValue('') | Should Be ''
        $after.GetValueKind('') | Should Be ([Microsoft.Win32.RegistryValueKind]::String)
    }

    It 'restores a prior handler with its registry value kind' {
        [void](New-Item -Path $script:handlerPath -Force)
        $handlerSubKey = $script:handlerPath.Substring('HKCU:\'.Length)
        $handlerRegistryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($handlerSubKey, $true)
        try { $handlerRegistryKey.SetValue('', '{11111111-1111-1111-1111-111111111111}', [Microsoft.Win32.RegistryValueKind]::ExpandString) }
        finally { $handlerRegistryKey.Dispose() }
        Set-ItemProperty -LiteralPath $script:handlerPath -Name 'ProviderNote' -Value 'keep this value'

        [void](Invoke-ThumbnailInstall -RegistryRoot $script:testClassesRoot)
        [void](Invoke-ThumbnailUninstall -RegistryRoot $script:testClassesRoot)

        $after = Get-Item -LiteralPath $script:handlerPath
        $after.GetValue('') | Should Be '{11111111-1111-1111-1111-111111111111}'
        $after.GetValueKind('') | Should Be ([Microsoft.Win32.RegistryValueKind]::ExpandString)
        $after.GetValue('ProviderNote') | Should Be 'keep this value'
    }

    It 'keeps the original backup across repeat installation' {
        [void](New-Item -Path $script:handlerPath -Force)
        Set-Item -LiteralPath $script:handlerPath -Value '{11111111-1111-1111-1111-111111111111}'

        [void](Invoke-ThumbnailInstall -RegistryRoot $script:testClassesRoot)
        [void](Invoke-ThumbnailInstall -RegistryRoot $script:testClassesRoot)
        [void](Invoke-ThumbnailUninstall -RegistryRoot $script:testClassesRoot)

        (Get-Item -LiteralPath $script:handlerPath).GetValue('') | Should Be '{11111111-1111-1111-1111-111111111111}'
    }

    It 'rolls back COM and handler values when registration fails partway through' {
        [void](New-Item -Path $script:handlerPath -Force)
        Set-Item -LiteralPath $script:handlerPath -Value '{11111111-1111-1111-1111-111111111111}'
        $testWriter = {
            param($Path, $Name, $Value, $Kind)
            if ($Name -eq 'ThreadingModel') { throw 'Injected registration write failure.' }
            Write-ThumbnailRegistryValue -Path $Path -Name $Name -Value $Value -Kind $Kind
        }

        $failed = $false
        try { [void](Invoke-ThumbnailInstall -RegistryRoot $script:testClassesRoot -RegistryWriteAction $testWriter) }
        catch { $failed = $_.Exception.Message -match 'Injected registration write failure' }
        $failed | Should Be $true

        (Get-Item -LiteralPath $script:handlerPath).GetValue('') | Should Be '{11111111-1111-1111-1111-111111111111}'
        $comPath = Join-Path $script:testClassesRoot 'CLSID\{c74c4f7e-ec39-44e4-9daa-78d6509384eb}\InprocServer32'
        (Test-Path -LiteralPath $comPath) | Should Be $false
    }

    It 'does not overwrite a handler changed by another provider during uninstall' {
        [void](Invoke-ThumbnailInstall -RegistryRoot $script:testClassesRoot)
        Set-Item -LiteralPath $script:handlerPath -Value '{22222222-2222-2222-2222-222222222222}'

        $removed = Invoke-ThumbnailUninstall -RegistryRoot $script:testClassesRoot

        $removed.conflict | Should Be $true
        (Get-Item -LiteralPath $script:handlerPath).GetValue('') | Should Be '{22222222-2222-2222-2222-222222222222}'
    }

    It 'reports an ExpandString handler takeover after uninstall and preserves its registry kind' {
        [void](Invoke-ThumbnailInstall -RegistryRoot $script:testClassesRoot)
        $handlerSubKey = $script:handlerPath.Substring('HKCU:\'.Length)
        $handlerRegistryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($handlerSubKey, $true)
        try { $handlerRegistryKey.SetValue('', '{33333333-3333-3333-3333-333333333333}', [Microsoft.Win32.RegistryValueKind]::ExpandString) }
        finally { $handlerRegistryKey.Dispose() }

        $removed = Invoke-ThumbnailUninstall -RegistryRoot $script:testClassesRoot

        $removed.conflict | Should Be $true
        $removed.message | Should Match '其他处理器已接管'
        $after = Get-Item -LiteralPath $script:handlerPath
        $after.GetValue('') | Should Be '{33333333-3333-3333-3333-333333333333}'
        $after.GetValueKind('') | Should Be ([Microsoft.Win32.RegistryValueKind]::ExpandString)
    }

    It 'rejects machine-wide and non-test registry roots before touching registration' {
        $failed = $false
        try { [void](Invoke-ThumbnailInstall -RegistryRoot 'HKLM:\Software\Classes') }
        catch { $failed = $_.Exception.Message -match 'HKCU' }

        $failed | Should Be $true
        (Test-Path -LiteralPath $script:testClassesRoot) | Should Be $false
    }
}
