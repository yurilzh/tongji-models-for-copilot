<#
.SYNOPSIS
    Packs this folder into tongji-copilot-<version>.vsix and (optionally) installs it.
.EXAMPLE
    .\build.ps1
    .\build.ps1 -Install
#>
[CmdletBinding()]
param(
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$package = [System.IO.File]::ReadAllText((Join-Path $src 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$version = $package.version
$out = Join-Path $src ("{0}-{1}.vsix" -f $package.name, $version)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$($package.name)" Version="$version" Publisher="$($package.publisher)" />
    <DisplayName>$($package.displayName)</DisplayName>
    <Description xml:space="preserve">$($package.description)</Description>
    <Tags>ai,chat,tongji,byok</Tags>
    <Categories>AI,Chat</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($package.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"@

$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".xml" ContentType="text/xml" />
</Types>
'@

if (Test-Path $out) {
    Remove-Item $out -Force
}

$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $addText = {
        param($name, $text)
        $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
        $stream = $entry.Open()
        $writer = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
        $writer.Write($text)
        $writer.Dispose()
        $stream.Dispose()
    }

    & $addText 'extension.vsixmanifest' $manifest
    & $addText '[Content_Types].xml' $contentTypes

    foreach ($file in @('package.json', 'extension.js')) {
        $entry = $zip.CreateEntry("extension/$file", [System.IO.Compression.CompressionLevel]::Optimal)
        $stream = $entry.Open()
        $bytes = [System.IO.File]::ReadAllBytes((Join-Path $src $file))
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Dispose()
    }
}
finally {
    $zip.Dispose()
}

Write-Host "Packed $out"
if ($Install) {
    code --install-extension $out --force
}
