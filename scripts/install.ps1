[CmdletBinding()]
param(
    [string]$TargetDir = (Join-Path $home '.gemini\config\plugins\antigravity-git-worktree'),
    [switch]$Link,
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
    规范化文件系统路径并移除非根目录的末尾斜杠。
.PARAMETER InputPath
    待规范化的目标路径字符串。
.OUTPUTS
    System.String 规范化后的绝对路径。
#>
function Resolve-NormalizedPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InputPath
    )

    $trimmed = $InputPath.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        throw 'TargetDir must not be empty.'
    }

    $fullPath = [System.IO.Path]::GetFullPath($trimmed)
    $rootPath = [System.IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.TrimEnd('\', '/') -eq $rootPath.TrimEnd('\', '/')) {
        return $fullPath
    }

    return $fullPath.TrimEnd('\', '/')
}

<#
.SYNOPSIS
    判断路径是否存在于文件系统（包括失效的 Junction 或符号链接）。
.PARAMETER Path
    待检查的路径。
.OUTPUTS
    System.Boolean 是否存在实体或重解析点。
#>
function Test-EntryExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    try {
        $null = [System.IO.File]::GetAttributes($Path)
        return $true
    }
    catch [System.IO.FileNotFoundException] {
        return $false
    }
    catch [System.IO.DirectoryNotFoundException] {
        return $false
    }
}

<#
.SYNOPSIS
    安全移除目标文件、普通目录或 Junction/Symlink，绝不跟随重解析点删除源目录。
.PARAMETER Path
    要移除的目标路径。
#>
function Remove-PathSafely {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-EntryExists -Path $Path)) {
        return
    }

    $attributes = [System.IO.File]::GetAttributes($Path)
    $isReparsePoint = ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0

    if ($isReparsePoint) {
        if ($isDirectory) {
            # 仅删除 Junction / 目录符号链接自身，严禁递归删除源仓库内容
            [System.IO.Directory]::Delete($Path, $false)
        }
        else {
            [System.IO.File]::Delete($Path)
        }
        return
    }

    if (-not $isDirectory) {
        if (($attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
            $writable = $attributes -band (-bnot [System.IO.FileAttributes]::ReadOnly)
            [System.IO.File]::SetAttributes($Path, $writable)
        }
        [System.IO.File]::Delete($Path)
        return
    }

    # 逐级安全清理普通目录，避免内置递归删除误触潜在嵌套重解析点
    foreach ($childPath in [System.IO.Directory]::EnumerateFileSystemEntries($Path)) {
        Remove-PathSafely -Path $childPath
    }

    if (($attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
        $writableDir = $attributes -band (-bnot [System.IO.FileAttributes]::ReadOnly)
        [System.IO.File]::SetAttributes($Path, $writableDir)
    }
    [System.IO.Directory]::Delete($Path, $false)
}

function Test-ExcludedEntryName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EntryName
    )

    $excludedNames = @(
        '.git',
        'docs',
        'tests',
        'scripts',
        'README.md',
        'tmp',
        '.scratch',
        'node_modules',
        '.DS_Store',
        'Thumbs.db',
        'desktop.ini'
    )

    if ($excludedNames -contains $EntryName) {
        return $true
    }
    if ($EntryName -like '*.log') {
        return $true
    }
    return $false
}

<#
.SYNOPSIS
    按白名单规则递归复制运行期目录，跳过非运行及临时产物文件。
.PARAMETER SourceDir
    源目录路径。
.PARAMETER DestDir
    目标目录路径。
#>
function Copy-FilteredTree {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceDir,
        [Parameter(Mandatory = $true)]
        [string]$DestDir
    )

    [System.IO.Directory]::CreateDirectory($DestDir) | Out-Null

    foreach ($entryPath in [System.IO.Directory]::EnumerateFileSystemEntries($SourceDir)) {
        $entryName = [System.IO.Path]::GetFileName($entryPath)
        if (Test-ExcludedEntryName -EntryName $entryName) {
            continue
        }

        $entryAttrs = [System.IO.File]::GetAttributes($entryPath)
        if (($entryAttrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            continue
        }

        $destEntryPath = Join-Path $DestDir $entryName
        if (($entryAttrs -band [System.IO.FileAttributes]::Directory) -ne 0) {
            Copy-FilteredTree -SourceDir $entryPath -DestDir $destEntryPath
        }
        else {
            [System.IO.File]::Copy($entryPath, $destEntryPath, $true)
        }
    }
}

function Assert-SafeTargetPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$NormalizedTarget,
        [Parameter(Mandatory = $true)]
        [string]$NormalizedRepoRoot
    )

    $pathRoot = [System.IO.Path]::GetPathRoot($NormalizedTarget)
    if ($NormalizedTarget.TrimEnd('\', '/') -eq $pathRoot.TrimEnd('\', '/')) {
        throw "Refusing to operate on filesystem root: $NormalizedTarget"
    }

    if ($NormalizedTarget.Equals($NormalizedRepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to overwrite or remove source repository directory: $NormalizedTarget"
    }

    $targetPrefix = $NormalizedTarget + [System.IO.Path]::DirectorySeparatorChar
    if ($NormalizedRepoRoot.StartsWith($targetPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate on an ancestor directory of the source repository: $NormalizedTarget"
    }
}

function Assert-SourceRuntimeFiles {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $pluginManifest = Join-Path $RepoRoot 'plugin.json'
    $logoAsset = Join-Path (Join-Path $RepoRoot 'assets') 'logo.svg'
    $sidecarManifest = Join-Path (Join-Path (Join-Path $RepoRoot 'sidecars') 'panel') 'sidecar.json'

    foreach ($requiredFile in @($pluginManifest, $logoAsset, $sidecarManifest)) {
        if (-not [System.IO.File]::Exists($requiredFile)) {
            throw "Required plugin runtime file not found: $requiredFile"
        }
    }
}

function Write-EnablementHint {
    Write-Output 'Next step: Open Antigravity Customizations and enable "Git Graph" (config.json was not modified).'
}

if ($Link -and $Uninstall) {
    throw 'Parameters -Link and -Uninstall cannot be used together.'
}

$repoRoot = Resolve-NormalizedPath -InputPath (Split-Path -Parent $PSScriptRoot)
$normalizedTarget = Resolve-NormalizedPath -InputPath $TargetDir
Assert-SafeTargetPath -NormalizedTarget $normalizedTarget -NormalizedRepoRoot $repoRoot

if ($Uninstall) {
    if (Test-EntryExists -Path $normalizedTarget) {
        Remove-PathSafely -Path $normalizedTarget
        Write-Output "Uninstalled 'Git Graph' (antigravity-git-worktree) from: $normalizedTarget"
    }
    else {
        Write-Output "Plugin 'Git Graph' is not installed at: $normalizedTarget"
    }
    exit 0
}

Assert-SourceRuntimeFiles -RepoRoot $repoRoot

$parentDir = Split-Path -Parent $normalizedTarget
if (-not [string]::IsNullOrWhiteSpace($parentDir)) {
    [System.IO.Directory]::CreateDirectory($parentDir) | Out-Null
}

if (Test-EntryExists -Path $normalizedTarget) {
    Remove-PathSafely -Path $normalizedTarget
}

if ($Link) {
    New-Item -ItemType Junction -Path $normalizedTarget -Target $repoRoot | Out-Null
    Write-Output "Linked 'Git Graph' (antigravity-git-worktree) junction: $normalizedTarget -> $repoRoot"
    Write-EnablementHint
    exit 0
}

[System.IO.Directory]::CreateDirectory($normalizedTarget) | Out-Null
[System.IO.File]::Copy(
    (Join-Path $repoRoot 'plugin.json'),
    (Join-Path $normalizedTarget 'plugin.json'),
    $true
)
Copy-FilteredTree -SourceDir (Join-Path $repoRoot 'assets') -DestDir (Join-Path $normalizedTarget 'assets')
Copy-FilteredTree `
    -SourceDir (Join-Path (Join-Path $repoRoot 'sidecars') 'panel') `
    -DestDir (Join-Path (Join-Path $normalizedTarget 'sidecars') 'panel')

Write-Output "Installed 'Git Graph' (antigravity-git-worktree) to: $normalizedTarget"
Write-EnablementHint
exit 0
