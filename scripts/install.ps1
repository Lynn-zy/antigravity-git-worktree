<#
.SYNOPSIS
    安装、更新或卸载 Antigravity 2.0 "Git Graph" 插件。
    Install, update, or uninstall the Antigravity 2.0 "Git Graph" plugin.
.DESCRIPTION
    默认仅将运行所需文件（plugin.json、assets/、sidecars/panel/）复制到目标插件目录，不修改 config.json。
    Copies only runtime files (plugin.json, assets/, sidecars/panel/) into the target plugin directory without modifying config.json.
.PARAMETER TargetDir
    目标插件安装目录（默认：~/.gemini/config/plugins/antigravity-git-worktree）。
    Target plugin installation directory (default: ~/.gemini/config/plugins/antigravity-git-worktree).
.PARAMETER Link
    创建指向源码仓库的目录联接（Junction），无需管理员权限。
    Create a directory junction pointing to the source repository (no admin privileges required).
.PARAMETER Uninstall
    安全移除已安装的目录或目录联接，绝不删除源码仓库内容。
    Safely remove the installed directory or junction without touching source repository files.
#>
[CmdletBinding()]
param(
    [string]$TargetDir = (Join-Path $home '.gemini\config\plugins\antigravity-git-worktree'),
    [switch]$Link,
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 管道或进程捕获标准输出时显式使用无 BOM UTF-8，避免非 UTF-8 代码页的 Windows 上中文乱码
if ([Console]::IsOutputRedirected) {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
}

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

function Invoke-WithLockRetry {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetPath,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action,
        [switch]$IgnoreNotFound
    )

    $retryDelaysMs = @(100, 200, 300, 500, 700, 700)
    for ($attempt = 0; $attempt -le $retryDelaysMs.Count; $attempt++) {
        try {
            & $Action
            return
        }
        catch {
            $inner = if ($null -ne $_.Exception.InnerException) { $_.Exception.InnerException } else { $_.Exception }
            if ($inner -is [System.IO.FileNotFoundException] -or $inner -is [System.IO.DirectoryNotFoundException]) {
                if ($IgnoreNotFound) {
                    return
                }
                throw
            }

            $isLockError = ($inner -is [System.IO.IOException]) -or ($inner -is [System.IO.UnauthorizedAccessException])
            if (-not $isLockError) {
                throw
            }

            if ($attempt -ge $retryDelaysMs.Count) {
                throw "Cannot modify or remove '$TargetPath' because it is locked by another process. If 'Git Graph' is running in Antigravity, disable it in Antigravity Customizations (or close any terminal using that folder) and retry. Original error: $($inner.Message)"
            }

            [System.Threading.Thread]::Sleep($retryDelaysMs[$attempt])
        }
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
            Invoke-WithLockRetry -TargetPath $Path -IgnoreNotFound -Action {
                [System.IO.Directory]::Delete($Path, $false)
            }
        }
        else {
            Invoke-WithLockRetry -TargetPath $Path -IgnoreNotFound -Action {
                [System.IO.File]::Delete($Path)
            }
        }
        return
    }

    if (-not $isDirectory) {
        if (($attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
            $writable = $attributes -band (-bnot [System.IO.FileAttributes]::ReadOnly)
            [System.IO.File]::SetAttributes($Path, $writable)
        }
        Invoke-WithLockRetry -TargetPath $Path -IgnoreNotFound -Action {
            [System.IO.File]::Delete($Path)
        }
        return
    }

    # 先删文件与重解析点再递归删子目录，确保 plugin.json 先被移除以触发宿主尽快释放 Sidecar 的 CWD 句柄
    $childDirs = New-Object 'System.Collections.Generic.List[string]'
    foreach ($childPath in [System.IO.Directory]::EnumerateFileSystemEntries($Path)) {
        $childAttrs = [System.IO.File]::GetAttributes($childPath)
        $childIsRealDir = (($childAttrs -band [System.IO.FileAttributes]::Directory) -ne 0) -and (($childAttrs -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)
        if ($childIsRealDir) {
            $childDirs.Add($childPath)
        }
        else {
            Remove-PathSafely -Path $childPath
        }
    }
    foreach ($childDir in $childDirs) {
        Remove-PathSafely -Path $childDir
    }

    if (($attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
        $writableDir = $attributes -band (-bnot [System.IO.FileAttributes]::ReadOnly)
        [System.IO.File]::SetAttributes($Path, $writableDir)
    }
    Invoke-WithLockRetry -TargetPath $Path -IgnoreNotFound -Action {
        [System.IO.Directory]::Delete($Path, $false)
    }
}

function Ensure-RealDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (Test-EntryExists -Path $Path) {
        $attributes = [System.IO.File]::GetAttributes($Path)
        $isReparsePoint = ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
        if ($isReparsePoint -or (-not $isDirectory)) {
            Remove-PathSafely -Path $Path
            [System.IO.Directory]::CreateDirectory($Path) | Out-Null
        }
        return
    }

    [System.IO.Directory]::CreateDirectory($Path) | Out-Null
}

function Copy-FileSafely {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceFile,
        [Parameter(Mandatory = $true)]
        [string]$DestFile
    )

    if (Test-EntryExists -Path $DestFile) {
        $destAttrs = [System.IO.File]::GetAttributes($DestFile)
        $isReparsePoint = ($destAttrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        $isDirectory = ($destAttrs -band [System.IO.FileAttributes]::Directory) -ne 0
        if ($isReparsePoint -or $isDirectory) {
            Remove-PathSafely -Path $DestFile
        }
        elseif (($destAttrs -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
            $writable = $destAttrs -band (-bnot [System.IO.FileAttributes]::ReadOnly)
            [System.IO.File]::SetAttributes($DestFile, $writable)
        }
    }

    Invoke-WithLockRetry -TargetPath $DestFile -Action {
        [System.IO.File]::Copy($SourceFile, $DestFile, $true)
    }
}

function Remove-UnexpectedChildren {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$AllowedNames
    )

    $allowedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $AllowedNames) {
        $null = $allowedSet.Add($name)
    }

    foreach ($existingPath in [System.IO.Directory]::EnumerateFileSystemEntries($Directory)) {
        $existingName = [System.IO.Path]::GetFileName($existingPath)
        if (-not $allowedSet.Contains($existingName)) {
            Remove-PathSafely -Path $existingPath
        }
    }
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
    按白名单规则原地递归同步运行期目录，保留既有目录实体并清理已过时残留项。
.PARAMETER SourceDir
    源目录路径。
.PARAMETER DestDir
    目标目录路径。
#>
function Sync-FilteredTree {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceDir,
        [Parameter(Mandatory = $true)]
        [string]$DestDir
    )

    Ensure-RealDirectory -Path $DestDir

    $expectedNames = New-Object 'System.Collections.Generic.List[string]'
    foreach ($entryPath in [System.IO.Directory]::EnumerateFileSystemEntries($SourceDir)) {
        $entryName = [System.IO.Path]::GetFileName($entryPath)
        if (Test-ExcludedEntryName -EntryName $entryName) {
            continue
        }

        $entryAttrs = [System.IO.File]::GetAttributes($entryPath)
        if (($entryAttrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            continue
        }

        $expectedNames.Add($entryName)
        $destEntryPath = Join-Path $DestDir $entryName
        if (($entryAttrs -band [System.IO.FileAttributes]::Directory) -ne 0) {
            Sync-FilteredTree -SourceDir $entryPath -DestDir $destEntryPath
        }
        else {
            Copy-FileSafely -SourceFile $entryPath -DestFile $destEntryPath
        }
    }

    Remove-UnexpectedChildren -Directory $DestDir -AllowedNames $expectedNames.ToArray()
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

function Write-BilingualResult {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$ZhLines,
        [Parameter(Mandatory = $true)]
        [string[]]$EnLines
    )

    foreach ($line in $ZhLines) {
        Write-Output $line
    }
    Write-Output ''
    foreach ($line in $EnLines) {
        Write-Output $line
    }
}

function Get-EnablementHint {
    param(
        [switch]$IsUpdate
    )

    if ($IsUpdate) {
        return @{
            Zh = '下一步：在 Antigravity Customizations 中先关闭再重新开启 "Git Graph"，以重新加载更新后的 Sidecar（未修改 config.json）。'
            En = 'Next step: In Antigravity Customizations, toggle "Git Graph" off and back on to reload the updated sidecar (config.json was not modified).'
        }
    }

    return @{
        Zh = '下一步：打开 Antigravity Customizations 并启用 "Git Graph"（未修改 config.json）。'
        En = 'Next step: Open Antigravity Customizations and enable "Git Graph" (config.json was not modified).'
    }
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
        Write-BilingualResult `
            -ZhLines @("已卸载 `"Git Graph`" (antigravity-git-worktree)：$normalizedTarget") `
            -EnLines @("Uninstalled 'Git Graph' (antigravity-git-worktree) from: $normalizedTarget")
    }
    else {
        Write-BilingualResult `
            -ZhLines @("未在以下路径检测到已安装的 `"Git Graph`"：$normalizedTarget") `
            -EnLines @("Plugin 'Git Graph' is not installed at: $normalizedTarget")
    }
    exit 0
}

Assert-SourceRuntimeFiles -RepoRoot $repoRoot

$wasAlreadyInstalled = $false
if (Test-EntryExists -Path $normalizedTarget) {
    $targetAttrs = [System.IO.File]::GetAttributes($normalizedTarget)
    if (($targetAttrs -band [System.IO.FileAttributes]::Directory) -ne 0) {
        $wasAlreadyInstalled = Test-EntryExists -Path (Join-Path $normalizedTarget 'plugin.json')
    }
}

$parentDir = Split-Path -Parent $normalizedTarget
if (-not [string]::IsNullOrWhiteSpace($parentDir)) {
    [System.IO.Directory]::CreateDirectory($parentDir) | Out-Null
}

if ($Link) {
    if (Test-EntryExists -Path $normalizedTarget) {
        Remove-PathSafely -Path $normalizedTarget
    }
    New-Item -ItemType Junction -Path $normalizedTarget -Target $repoRoot | Out-Null
    $hint = Get-EnablementHint -IsUpdate:$wasAlreadyInstalled
    Write-BilingualResult `
        -ZhLines @(
            "已创建 `"Git Graph`" (antigravity-git-worktree) 目录联接（Junction）：$normalizedTarget -> $repoRoot",
            $hint.Zh
        ) `
        -EnLines @(
            "Linked 'Git Graph' (antigravity-git-worktree) junction: $normalizedTarget -> $repoRoot",
            $hint.En
        )
    exit 0
}

# 默认拷贝模式原地同步目录树：保留既有普通目录实体，避免运行中的 Sidecar 占用 sidecars\panel 为 CWD 导致覆盖安装报 IOException
Ensure-RealDirectory -Path $normalizedTarget
$destSidecarsDir = Join-Path $normalizedTarget 'sidecars'
Ensure-RealDirectory -Path $destSidecarsDir

Sync-FilteredTree -SourceDir (Join-Path $repoRoot 'assets') -DestDir (Join-Path $normalizedTarget 'assets')
Sync-FilteredTree `
    -SourceDir (Join-Path (Join-Path $repoRoot 'sidecars') 'panel') `
    -DestDir (Join-Path $destSidecarsDir 'panel')
Copy-FileSafely `
    -SourceFile (Join-Path $repoRoot 'plugin.json') `
    -DestFile (Join-Path $normalizedTarget 'plugin.json')

Remove-UnexpectedChildren -Directory $destSidecarsDir -AllowedNames @('panel')
Remove-UnexpectedChildren -Directory $normalizedTarget -AllowedNames @('plugin.json', 'assets', 'sidecars')

$hint = Get-EnablementHint -IsUpdate:$wasAlreadyInstalled
if ($wasAlreadyInstalled) {
    $zhStatus = "已更新 `"Git Graph`" (antigravity-git-worktree)：$normalizedTarget"
    $enStatus = "Updated 'Git Graph' (antigravity-git-worktree) at: $normalizedTarget"
}
else {
    $zhStatus = "已将 `"Git Graph`" (antigravity-git-worktree) 安装至：$normalizedTarget"
    $enStatus = "Installed 'Git Graph' (antigravity-git-worktree) to: $normalizedTarget"
}
Write-BilingualResult `
    -ZhLines @($zhStatus, $hint.Zh) `
    -EnLines @($enStatus, $hint.En)
exit 0
