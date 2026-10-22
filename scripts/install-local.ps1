#Requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidateSet("Inject", "Uninject")] [string] $Action,
    [switch] $CheckOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

try
{
    $id = "com.kpk.session-stats"
    $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..")).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $homePath = $env:CODEX_PLUSPLUS_HOME
    if (!$homePath)
    {
        if (!$env:APPDATA) { throw "APPDATA is not available." }
        $homePath = Join-Path $env:APPDATA "codex-plusplus"
    }
    $homePath = [IO.Path]::GetFullPath($homePath)
    $tweaksPath = Join-Path $homePath "tweaks"
    $linkPath = Join-Path $tweaksPath $id
    $configPath = Join-Path $homePath "config.json"
    $item = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
    $status = "Missing"
    if ($null -ne $item)
    {
        $status = "Blocked"
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
        {
            if ($item.LinkType -eq "Junction" -and @($item.Target).Count -eq 1)
            {
                $target = [IO.Path]::GetFullPath([string] @($item.Target)[0]).TrimEnd(
                    [IO.Path]::DirectorySeparatorChar)
                if ([string]::Equals($target, $source, [StringComparison]::OrdinalIgnoreCase))
                {
                    $status = "Linked"
                }
            }
        }
        elseif ($item.PSIsContainer)
        {
            $manifestPath = Join-Path $linkPath "manifest.json"
            if (Test-Path -LiteralPath $manifestPath -PathType Leaf)
            {
                $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable
                if ($manifest.id -eq $id) { $status = "Installed" }
            }
        }
    }

    Write-Host "Status: $status"
    Write-Host "Tweak source: $source"
    Write-Host "Tweak path: $linkPath"
    if ($status -eq "Blocked")
    {
        [Console]::Error.WriteLine("Blocked: the tweak path is unrelated or links to another source.")
        exit 2
    }

    $config = @{}
    if (Test-Path -LiteralPath $configPath)
    {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -AsHashtable
    }
    if ($config -isnot [Collections.IDictionary] -or
        ($null -ne $config["tweaks"] -and $config["tweaks"] -isnot [Collections.IDictionary]) -or
        ($null -ne $config["tweaks"] -and $null -ne $config["tweaks"][$id] -and
            $config["tweaks"][$id] -isnot [Collections.IDictionary]))
    {
        throw "Invalid Codex++ config: expected objects for config, tweaks, and this tweak's settings."
    }

    if ($Action -eq "Inject")
    {
        $manifest = Get-Content -LiteralPath (Join-Path $source "manifest.json") -Raw | ConvertFrom-Json
        if ($manifest.id -ne $id -or !(Test-Path -LiteralPath (Join-Path $source $manifest.main) -PathType Leaf))
        {
            throw "Session Stats manifest or entry point is invalid."
        }
    }
    if ($CheckOnly -or ($Action -eq "Uninject" -and $status -eq "Missing")) { exit 0 }

    if ($Action -eq "Inject" -and $status -eq "Missing")
    {
        New-Item -ItemType Directory -Path $tweaksPath -Force | Out-Null
        New-Item -ItemType Junction -Path $linkPath -Target $source | Out-Null
    }

    $enabled = $Action -eq "Inject"
    if ($null -eq $config["tweaks"]) { $config["tweaks"] = @{} }
    if ($null -eq $config["tweaks"][$id]) { $config["tweaks"][$id] = @{} }
    if ($config["tweaks"][$id]["enabled"] -cne $enabled)
    {
        $config["tweaks"][$id]["enabled"] = $enabled
        $temporaryPath = Join-Path $homePath ("config.json." + [guid]::NewGuid().ToString("N") + ".tmp")
        try
        {
            [IO.File]::WriteAllText($temporaryPath, ($config | ConvertTo-Json -Depth 100) + [Environment]::NewLine)
            [IO.File]::Move($temporaryPath, $configPath, $true)
        }
        finally
        {
            if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath }
        }
    }

    if ($Action -eq "Uninject" -and $status -eq "Linked")
    {
        if ([IO.Path]::GetDirectoryName($linkPath) -ne $tweaksPath -or [IO.Path]::GetFileName($linkPath) -ne $id)
        {
            throw "The tweak path is outside the expected tweaks directory."
        }
        # 只移除已确认的链接，禁止递归删除源目录。
        Remove-Item -LiteralPath $linkPath
        if (Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue)
        {
            throw "The tweak junction still exists after removal."
        }
    }
    if ($Action -eq "Inject")
    {
        Write-Host "Session Stats is enabled. Restart Codex to load it."
    }
    else
    {
        Write-Host "Session Stats is disabled. Any Store copy was preserved. Restart Codex to unload it."
    }
    exit 0
}
catch
{
    Write-Error $_
    exit 1
}
