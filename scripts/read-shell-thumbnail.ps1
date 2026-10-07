param(
    [Parameter(Mandatory = $true)]
    [string] $VideoPath,

    [Parameter(Mandatory = $true)]
    [string] $OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$typeDefinition = @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct CoverProbeSize
{
    public int cx;
    public int cy;
}

[ComImport]
[Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItemImageFactory
{
    [PreserveSig]
    int GetImage(CoverProbeSize size, int flags, out IntPtr bitmap);
}

public static class CoverProbeShellNative
{
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetImageDelegate(IntPtr imageFactory, CoverProbeSize size, int flags, out IntPtr bitmap);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    public static extern int SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string parsingName,
        IntPtr bindContext,
        ref Guid interfaceId,
        out IntPtr imageFactory);

    public static int RequestThumbnail(
        IntPtr imageFactory,
        CoverProbeSize size,
        int flags,
        out IntPtr bitmap)
    {
        IntPtr vtable = Marshal.ReadIntPtr(imageFactory);
        IntPtr method = Marshal.ReadIntPtr(vtable, 3 * IntPtr.Size); // IUnknown methods occupy slots 0-2.
        GetImageDelegate getImage = (GetImageDelegate)Marshal.GetDelegateForFunctionPointer(method, typeof(GetImageDelegate));
        return getImage(imageFactory, size, flags, out bitmap);
    }

    [DllImport("gdi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeleteObject(IntPtr objectHandle);
}
'@

function Get-WindowsBuildInfo {
    $key = Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    return [pscustomobject]@{
        productName = $key.ProductName
        displayVersion = $key.DisplayVersion
        currentBuild = $key.CurrentBuild
        updateBuildRevision = $key.UBR
    }
}

function Format-HResult([int] $HResult) {
    return ('0x{0:X8}' -f ($HResult -band 0xffffffffL))
}

    $factory = [IntPtr]::Zero
$bitmap = [IntPtr]::Zero
$image = $null
$exitCode = 1

try {
    if (-not [IO.Path]::IsPathRooted($VideoPath)) {
        throw 'VideoPath must be an absolute filesystem path.'
    }
    if (-not [IO.Path]::IsPathRooted($OutputPath)) {
        throw 'OutputPath must be an absolute filesystem path.'
    }
    $VideoPath = [IO.Path]::GetFullPath($VideoPath)
    $OutputPath = [IO.Path]::GetFullPath($OutputPath)
    if (-not (Test-Path -LiteralPath $VideoPath -PathType Leaf)) {
        throw "VideoPath does not exist: $VideoPath"
    }
    if (Test-Path -LiteralPath $OutputPath) {
        throw "OutputPath already exists; refusing to overwrite: $OutputPath"
    }
    $outputDirectory = [IO.Path]::GetDirectoryName($OutputPath)
    if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
        [void][IO.Directory]::CreateDirectory($outputDirectory)
    }

    Add-Type -TypeDefinition $typeDefinition -ErrorAction Stop
    $imageFactoryId = [Guid]'bcc18b79-ba16-442f-80c4-8a59c30c463b'
    $createResult = [CoverProbeShellNative]::SHCreateItemFromParsingName(
        $VideoPath,
        [IntPtr]::Zero,
        [ref]$imageFactoryId,
        [ref]$factory)
    if ($createResult -lt 0) {
        $windows = Get-WindowsBuildInfo
        throw "SHCreateItemFromParsingName failed HRESULT=$(Format-HResult $createResult); Windows=$($windows.productName) $($windows.displayVersion) build $($windows.currentBuild).$($windows.updateBuildRevision); path=$VideoPath"
    }
    if ($factory -eq [IntPtr]::Zero) {
        throw 'SHCreateItemFromParsingName succeeded without returning an IShellItemImageFactory pointer.'
    }

    $size = [CoverProbeSize]::new()
    $size.cx = 256
    $size.cy = 256
    $getImageResult = [CoverProbeShellNative]::RequestThumbnail($factory, $size, 0x8, [ref]$bitmap) # SIIGBF_THUMBNAILONLY
    if ($getImageResult -lt 0) {
        $windows = Get-WindowsBuildInfo
        throw "IShellItemImageFactory.GetImage failed HRESULT=$(Format-HResult $getImageResult); Windows=$($windows.productName) $($windows.displayVersion) build $($windows.currentBuild).$($windows.updateBuildRevision); requested=256x256 SIIGBF_THUMBNAILONLY; path=$VideoPath"
    }
    if ($bitmap -eq [IntPtr]::Zero) {
        throw "IShellItemImageFactory.GetImage returned HRESULT=$(Format-HResult $getImageResult) with a null HBITMAP; path=$VideoPath"
    }

    Add-Type -AssemblyName System.Drawing
    $image = [System.Drawing.Image]::FromHbitmap($bitmap)
    $image.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $windows = Get-WindowsBuildInfo
    [pscustomobject]@{
        status = 'success'
        videoPath = $VideoPath
        outputPath = $OutputPath
        hresult = Format-HResult $getImageResult
        requestedSize = '256x256'
        flags = 'SIIGBF_THUMBNAILONLY (0x8)'
        windows = $windows
        method = 'SHCreateItemFromParsingName / IShellItemImageFactory.GetImage'
    } | ConvertTo-Json -Compress -Depth 4 | Write-Output
    $exitCode = 0
}
catch {
    $windowsText = '<Windows build unavailable>'
    try {
        $windows = Get-WindowsBuildInfo
        $windowsText = "$($windows.productName) $($windows.displayVersion) build $($windows.currentBuild).$($windows.updateBuildRevision)"
    }
    catch {
        # Keep the original failure when the registry itself cannot be read.
    }
    [Console]::Error.WriteLine("Shell thumbnail extraction failed; Windows=$windowsText; path=$VideoPath; output=$OutputPath; error=$($_.Exception.Message)")
    $exitCode = 1
}
finally {
    if ($null -ne $image) {
        $image.Dispose()
    }
    if ($bitmap -ne [IntPtr]::Zero) {
        [void][CoverProbeShellNative]::DeleteObject($bitmap)
    }
    if ($factory -ne [IntPtr]::Zero) {
        [void][Runtime.InteropServices.Marshal]::Release($factory)
    }
}

exit $exitCode
