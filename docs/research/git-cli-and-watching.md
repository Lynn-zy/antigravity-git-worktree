# 零依赖 Node.js + Git CLI 在 Windows 与多 Worktree 下的图谱数据、文件监听与并发锁策略调研

本文总结 `antigravity-git-worktree`（受 [ADR-0001](../adr/0001-pure-official-sidecar-and-scope-focus.md) 与 [ADR-0002](../adr/0002-zero-build-esm-and-svg-graph.md) 约束）在零外部运行时依赖、纯 Node.js（`>=20`）ESM 下通过 `git` CLI 驱动多仓库与多 `Worktree`、`Commit Graph` 数据提取、`Working Tree Changes` 增量监听、Windows 路径编码及锁冲突防护的实测事实与工程契约。概念命名对齐 [GLOSSARY.md](../../GLOSSARY.md)。

## 一手来源与实测环境

- **实测宿主环境**：Windows (`win32 x64`)、`git version 2.53.0.windows.2`、`Node.js v22.23.4`、Git Credential Manager `2.7.3+5fa7116896c82164996a609accd1c5ad90fe730a`（`git config --show-origin --get-all credential.helper` 检出系统级配置 `file:C:/Program Files/Git/etc/gitconfig` 为 `manager`）。
- **官方 Sidecar SDK 与同工作区参考实现**：
  - `C:\Users\linse\.gemini\antigravity\lib\node_modules\sidecar_sdk\preload.js#L24-L77,L352-L388`（`workspace-change` 推送与 `getWorkspaceUris()` / `onWorkspaceChange()` 契约）
  - `C:\Users\linse\.gemini\antigravity\lib\node_modules\sidecar_sdk\index.mjs#L93-L108`（Windows `execFileSync` 不依赖 `.bat` 与 `shell: true`）
  - `D:\private\Antigrative-Dashboard\antigrative-dashboard-0.9.1\sidecars\panel\updater.mjs#L15-L25`（`releaseRuntimeDirectory()` 避免侧栏进程 `cwd` 锁住目录）
  - `D:\private\Antigrative-Dashboard\antigrative-dashboard-0.9.1\compat\sidecar-owner.mjs#L94-L98`（监听父目录而非直接监听被原子替换的单文件）
- **Git 官方本地文档（随 Git 2.53.0 分发）与规范文档**：
  - `C:\Program Files\Git\mingw64\share\doc\git-doc\git-rev-parse.html#L751-L811`（`--path-format=(absolute|relative)` 与 `--show-toplevel`）
  - `C:\Program Files\Git\mingw64\share\doc\git-doc\RelNotes\2.31.0.adoc#L39`（`--path-format` 引入版本 `2.31.0`）
  - `C:\Program Files\Git\mingw64\share\doc\git-doc\git-worktree.html#L1000-L1054`（`--porcelain -z` 规范）
  - `C:\Program Files\Git\mingw64\share\doc\git-doc\git-status.html#L987-L1100`（`--porcelain=v2` 规范）
  - `C:\Program Files\Git\mingw64\share\doc\git-doc\git-log.html#L2456-L2490`（`%D` 与 `%(decorate:...)`）
  - `C:\Program Files\Git\mingw64\share\doc\git-doc\git.html#L2165-L2169,L2472-L2480`（`GIT_TERMINAL_PROMPT` 与 `GIT_OPTIONAL_LOCKS`）
  - `C:\Program Files\Git\mingw64\share\doc\git-doc\gitcli.html#L507`（`--end-of-options`）
  - Git Credential Manager 官方文档（`GCM_INTERACTIVE` / `credential.interactive`）、Node.js 官方 `fs.watch` `recursive` 文档（Node 19.1+ / 20+ 原生支持 Linux/macOS/Windows）、OpenSSH `BatchMode=yes` / `SSH_ASKPASS_REQUIRE=never` 文档。

---

## 一、多仓库与 Worktree 发现（`Workspace -> Repository -> Worktree[]`）

### 1.1 `file://` URI 转本地路径与 Windows 大小写归一化

`sidecar_sdk/preload.js#L59-L76,L352-L388` 通过 `window.sidecar.getWorkspaceUris()` 与 `onWorkspaceChange(listener)` 暴露宿主当前对话的 `workspaceUris`（`string[]`）。在 Windows 上，VS Code / Antigravity 传入的 URI 可能出现盘符编码 `%3A`、小写盘符 `c:`、百分比编码中文或尾斜杠。

对 `file:///c%3A/.../%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95/casedir/`、`file:///C:/.../CaseDir`、`file://localhost/c:/...`、`file://server/share/folder` 的实测结果如下：

1. Node.js 内置 `fileURLToPath(uri)`（`node:url`）能正确解码 `%3A`、`%E4%B8%AD%E6%96%87`、`localhost` 与 UNC 路径（如 `\\server\share\folder`），但保留原盘符与路径大小写（`c:\...\casedir\`）。
2. 对磁盘存在的目录调用 `fs.realpathSync.native(fsPath)`，Windows 返回真实盘符大写与 NTFS 目录原始大小写（如 `C:\...\中文 目录\CaseDir`），同时展开 junction / symlink。
3. 当路径不存在或不可达时（如已删除的 `Worktree` 或离线 UNC），`realpathSync.native()` 抛出 `ENOENT` 或 `UNKNOWN`。因此必须提供非抛出兜底规范化：`path.win32.normalize()`、去除非盘符根目录末尾 `\`、并将 `^[a-z]:` 转为大写，再与 Git 输出（正斜杠 `/`、盘符已大写）统一转为同一种比较键（Windows 下按小写比对或统一 `realpathSync.native` 后再比较）。

### 1.2 `git rev-parse` 的组合调用陷阱与精确探测

在主仓库根目录、主仓库子目录、`.git` 目录内部、linked `Worktree`（含小写盘符 `c:\...` 和中文目录名）、bare 仓库、bare 仓库挂载的 linked `Worktree` 与非 Git 目录上实测 `git rev-parse`，得到如下关键边界：

| 探测目录 | `--git-common-dir`（不带 `--path-format`） | `--path-format=absolute --git-common-dir --git-dir --is-inside-work-tree --is-bare-repository` | 加 `--show-toplevel` 的结果 |
| --- | --- | --- | --- |
| 主仓库根目录 | `.git`（相对路径） | exit `0`，返回绝对路径 `C:/.../repo/.git`、`true`、`false` | exit `0` |
| 主仓库子目录 `src/sub` | `../../.git`（相对 `cwd`） | exit `0`，返回绝对路径 `C:/.../repo/.git`、`true`、`false` | exit `0` |
| `.git` 目录内部 | `.` | exit `0`，`is-inside-work-tree=false` | **exit `128`（整条命令中止）** |
| linked `Worktree`（含 `c:\` 小写入口） | `C:/.../repo/.git` | exit `0`，Git 自动转为大写盘符 `C:/...` | exit `0`，返回 `wt` 根路径 |
| bare 仓库根目录 | `.` | exit `0`，`is-inside-work-tree=false`、`is-bare-repository=true` | **exit `128`（整条命令中止）** |
| bare 仓库的 linked `Worktree` | `C:/.../bare.git` | exit `0`，`is-inside-work-tree=true`、`is-bare-repository=false` | exit `0`，返回 `wt` 根路径 |
| 非 Git 目录 | exit `128` | exit `128` | exit `128` |

**工程结论**：
1. **禁止将 `--show-toplevel` 与 `--git-common-dir` 混在第一阶段探测中**：`git-rev-parse.html#L800-L804` 明确若无工作树则 `--show-toplevel` 报错。第一阶段应执行 `git rev-parse --path-format=absolute --git-common-dir --git-dir --is-inside-work-tree --is-bare-repository`；仅当 `isInsideWorkTree === 'true'` 时再按需执行 `--show-toplevel`（实际上配合 `worktree list` 也已能获取全部工作树根路径）。
2. **Git 版本兜底**：`--path-format=absolute` 自 Git `2.31.0` 引入（`RelNotes/2.31.0.adoc#L39`）。若遇旧版本 Git 报 `unknown option`，降级为去掉 `--path-format=absolute` 后在 Node 侧用 `path.resolve(cwd, line)` 绝对化。
3. **Submodule 边界**：若 `Workspace` 包含一个 Git submodule 子目录，`--git-common-dir` 会返回 `<superproject>/.git/modules/<name>` 而非父仓库 `.git`。可用 `--show-superproject-working-tree`（`git-rev-parse.html#L805-L810`）识别它属于子模块。

### 1.3 `git worktree list --porcelain -z` 字段契约

以 `-c core.quotepath=false worktree list --porcelain -z` 对包含正常主工作树、linked worktree、`detached`、带空格与中文 reason 的 `locked`、无 reason `locked`、`prunable`、中文目录名、unborn 仓库与 bare 仓库进行实测，输出的 NUL 分隔记录结构如下：

- 记录以空字符串 `''`（连续两个 `\0`）分隔，第一行恒为 `worktree <path>`（Git for Windows 统一输出正斜杠且大写盘符，即使最初以 `c:\...` 创建 `Worktree`，列表中仍归一化为 `C:/...`）。
- 若为主 bare 仓库条目：第二行直接为 `bare`。
- 若为非 bare 工作树条目：
  - `HEAD <40位或64位hex>`：实测刚刚 `git init` 且 0 提交的 unborn 仓库会输出 `HEAD 0000000000000000000000000000000000000000` 并附带 `branch refs/heads/<name>`。
  - 分支状态二选一：`branch refs/heads/...` 或 `detached`。
  - 可选属性：`locked` 或 `locked <reason>`（`-z` 下换行等字符不被转义，可直接按 `startsWith('locked ')` 截取第 7 位之后全部文本）；`prunable` 或 `prunable <reason>`（例如实测删除目录后返回 `prunable gitdir file points to non-existent location`）。

### 1.4 去重归并与 `Conversation-Bound Worktree` 判定

1. **按 `Repository` 归并**：对每个解析出的 `Workspace` 目录运行探测，将 `gitCommonDir` 经 `realpathSync.native`（并按平台大小写策略归一化）作为 `Repository.id`。多个 `Workspace` URI 指向同一仓库的不同 `Worktree` 或子目录时，自动去重为同一个 `Repository`，只执行一次 `git worktree list --porcelain -z` 填充 `Worktree[]`。
2. **匹配 `Conversation-Bound Worktree`**：对每个 `Workspace` 目录 `wsPath`，在已发现的 `Worktree[]` 中查找 `wsPath === wt.path` 或 `wsPath` 位于 `wt.path` 之下（按路径段前缀匹配，不可用纯字符串 `startsWith`，避免 `D:/repo` 误匹配 `D:/repo-wt`）。当存在嵌套（例如工作区指向子模块或嵌套 worktree）时，取 **`wt.path` 长度最长**的匹配项。一个 `Workspace` 打开多个目录时，可能有多个 `Conversation-Bound Worktree` 标记。

---

## 二、结构化 `Commit Graph` 与变更查询格式

### 2.1 `Commit Graph` 最优 `git log` 命令与格式串

推荐命令：

```text
git -c core.quotepath=false -c i18n.logOutputEncoding=utf-8 --no-pager \
  log --exclude=refs/stash --all --topo-order --decorate=full -z \
  --format=%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%at%x1f%s
```

实测验证了以下关键细节：

1. **为何选 `--exclude=refs/stash --all`**：
   - 实测 `--all` 会将 `refs/stash` 及其内部 `index on <branch>` 两个辅助节点直接混入 `Commit Graph`。
   - 实测 `--branches --tags --remotes` 虽然避开了 stash，但会漏掉**另一个 linked `Worktree` 上处于 `detached HEAD` 的独占提交**；而在后面显式追加 `HEAD` 在 0 提交 unborn 仓库中会以 exit `128` 失败（`fatal: ambiguous argument 'HEAD'`）。
   - 实测 `--exclude=refs/stash --all` 在包含 stash 的仓库中能完整排除 stash 伪提交，同时包含其他 `Worktree` 的 `detached HEAD` 提交；且在 0 提交 unborn 仓库中返回 exit `0` 与空输出 `""`。
2. **为何用 `-z` 且不在 `--format` 末尾手写 `%x00`**：
   - 实测 `--format=...%x00`（不带 `-z`）会在每两条提交之间保留默认的 `\n` 分隔符，导致第二条记录以 `\n` 开头；传入 `-z` 并移除末尾 `%x00` 后，Git 严格以单个 `\0` 分隔提交记录，实测输出无前导换行。
   - 字段间用 `\x1f`（Unit Separator）分隔，末尾仅放单行主题 `%s`（Git 会将正文换行折叠为空格），可防止多行提交正文污染记录边界。若面板详情抽屉需要完整正文 `%B`，应在点击单个提交时按 `git show -s --format=%B <sha>` 懒加载。
3. **`%D` 与 `--decorate=full` 的分支名安全性**：
   - `%D` 在 `--decorate=full` 下输出形如 `HEAD -> refs/heads/main, tag: refs/tags/v1.0.0, refs/remotes/origin/main`（`git-log.html#L2460-L2463`）。
   - 实测 `git check-ref-format "refs/heads/a, b"` 返回 exit `1`（Git ref 名严禁包含空格），而 `"refs/heads/a,b"` 返回 exit `0`。因此 `", "`（逗号加空格）和 `" -> "` 在所有 Git 版本中均不会与合法分支/标签名碰撞。若针对 Git `>=2.40` 也可使用 `%(decorate:prefix=,suffix=,separator=%x1d,tag=tag:,pointer=->)`，但 `%D` 跨版本兼容性更好。
4. **分页与快照漂移**：
   - `git rev-list --count --exclude=refs/stash --all` 可统计总提交数（在 unborn 仓库下返回 `0`），配合 `--skip=<offset> -n <limit>` 翻页。
   - 若用户边翻页边发生新提交或 `fetch`，`--skip` 会向后漂移导致重复节点。推荐两种做法之一：以首屏查询时的总加载上限重拉（例如每次“加载更多”将 `limit` 递增 `200`，由后端做小规模增量缓存）或按当前已加载节点集合去重合并。

### 2.2 `Working Tree Changes`：`git status --porcelain=v2` 解析细节

推荐命令：

```text
git -c core.quotepath=false --no-optional-locks status --porcelain=v2 --branch --show-stash -z
```

实测覆盖中文文件名、空格、以 `-` 开头文件名、重命名+修改、未跟踪与合并冲突状态，确认契约如下：

- **分支与 Stash 头**：
  - `# branch.oid <sha>`（unborn 仓库为 `# branch.oid (initial)`）
  - `# branch.head <name>`（游离态为 `# branch.head (detached)`）
  - `# branch.upstream <upstream>` 与 `# branch.ab +<ahead> -<behind>`（仅存在上游时出现）
  - `# stash <N>`（`N > 0` 时出现）
- **变更条目（必须使用索引指针顺序消费 `tokens`）**：
  - 普通变更：`1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`（仅占 1 个 NUL token，按前 8 个空格切分出前 8 列，第 9 列起直到结尾整体作为 `path`，以保留文件名中的空格）。
  - 重命名/复制：`2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <newPath>` 后紧跟**下一个 NUL token** `<origPath>`（占 2 个 NUL token，**`newPath` 在前、`origPath` 在后**）。
  - 冲突条目：`u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`（`XY` 如 `AA`、`UU`、`DU`）。
  - 未跟踪/忽略：`? <path>`、`! <path>`。

### 2.3 `git diff` / `git show` / 未跟踪预览与二进制、大文件截断

1. **摘要列表（`--numstat -M -z`）的字段顺序陷阱**：
   - 对未暂存：`git -c core.quotepath=false --no-optional-locks diff --numstat -M -z`
   - 对已暂存：`git -c core.quotepath=false --no-optional-locks diff --cached --numstat -M -z`
   - 实测在 `-z` 下：**普通与二进制文件**为单个 token `<added>\t<deleted>\t<path>`（二进制为 `-\t-\t<path>`）；**重命名或复制文件**为 3 个连续 token：`<added>\t<deleted>\t`（第三段为空串）、`<origPath>`、`<newPath>`。**注意：`--numstat -z` 是 `origPath` 在前、`newPath` 在后，与 `status --porcelain=v2 -z` 完全相反**。
2. **单文件 Patch 与 Commit Diff**：
   - 工作区与暂存区单文件 Patch：
     `git -c core.quotepath=false -c diff.mnemonicPrefix=false -c diff.noprefix=false --no-pager --no-optional-locks diff [--cached] --no-ext-diff --no-color -M --unified=3 -- <path>`
     （显式关闭 `diff.mnemonicPrefix` 与 `diff.noprefix` 可避免用户全局配置把 `a/`、`b/` 改写为 `i/`、`w/` 导致解析失败）。
   - Commit Diff（含根提交与 Merge Commit）：
     `git -c core.quotepath=false -c diff.mnemonicPrefix=false -c diff.noprefix=false --no-pager show --no-ext-diff --no-color -M -m --first-parent --format= <sha> [-- <path>]`
     实测对冲突解决后的 Merge Commit，不带 `-m --first-parent` 时 `git show` 默认输出 `diff --cc` 多列格式（`@@@` 与双符号前缀），而加上 `-m --first-parent` 后稳定输出相对第一父提交的标准两列 `diff --git` 统一补丁；实测比 `git diff-tree -m --first-parent` 更干净（后者在 clean merge 上会同时输出第一与第二父提交两份差异）。根提交下 `git show` 同样正常生成从 `/dev/null` 新增的补丁。
3. **未跟踪文件预览**：
   - `git -c core.quotepath=false --no-pager diff --no-index --no-ext-diff --no-color -- /dev/null <path>`。
   - **实测退出码陷阱**：Git for Windows 支持 `/dev/null` 与 `NUL`，但只要文件非空有差异，`--no-index` 返回**退出码 `1`**（而非 `0`）。执行层必须把 `code === 0 || code === 1`（且无致命 stderr）视为成功。
4. **二进制、大文件与非 UTF-8 截断**：
   - 概览阶段先由 `--numstat -z` 识别 `-\t-\t` 二进制项；未跟踪文件先 `fs.stat` 检查体积（并嗅探前 8 KiB 是否含 `0x00` 判定二进制）。
   - 拉取单文件 Patch 时不要无上限缓冲全量 `execFile`：使用 `spawn` 流式收集 `stdout` 并设硬上限（如 `MAX_PATCH_BYTES = 256 * 1024`），超过上限立即写入截断标记并 `child.kill()`；在截断后需按换行边界回退，避免在多字节 UTF-8 字符中间切断。
   - 实测对 GBK 编码文件直接 `.toString('utf8')` 会产生 `\uFFFD` 替换字符与错位字符（如原字节序列含 `0xC4 0xB2` 时被解为 `U+0132`）。输出仍应按 UTF-8 解码以保证 JSON 契约可用，并可在检测到 `\uFFFD` 时在前端显示“文件非 UTF-8 编码，部分字符显示为占位符”提示，不猜测或改写原始文件内容。

---

## 三、Windows 编码、跨平台路径与 `execFile` / `spawn` 安全契约

所有 Git 调用必须遵守以下统一契约：

1. **进程启动选项**：使用 `child_process.execFile('git', args, opts)` 或 `spawn('git', args, opts)`，**严禁设置 `shell: true`**（`sidecar_sdk/index.mjs#L95-L106` 也注明了规避 Windows `.bat` 注入风险）。必须传入 `windowsHide: true`（防止 Windows 侧栏高频刷新时弹出/闪烁控制台窗口）及 `stdio: ['ignore', 'pipe', 'pipe']`。
2. **输出解码与编码参数**：在 `execFile` / `spawn` 中保留 `Buffer` 原始输出再手动解析 `-z`（NUL 分隔的二进制安全切片后再 `toString('utf8')`）。所有查询统一在子命令前注入：
   - `-c core.quotepath=false`：禁止 Git 对中文路径做八进制转义。
   - `-c i18n.logOutputEncoding=utf-8`：强制提交信息与作者名输出 UTF-8。
   - `--no-pager`：防止分页器阻塞。
3. **参数注入防护**：
   - 任意文件路径参数前必须加 `--`（实测文件名 `-weird-file.txt` 不加 `--` 会被当成命令行选项）。
   - 任意由数据驱动的 revision / branch / tag 参数前应加 `--end-of-options`（`gitcli.html#L507`），将用户/仓库数据与 CLI flag 彻底隔离。

---

## 四、文件系统监听、Windows 句柄防护与并发锁 / 凭据策略

### 4.1 `fs.watch` 监听范围与去抖模型

在 Windows 上对 `.git`、`HEAD`、`refs` 与 `worktrees` 的实测揭示了四项必须处理的底层行为：

1. **监听父目录而非单文件**：Git 更新 `HEAD`、`index`、`packed-refs` 与分支引用时，都会先写入 `*.lock` 临时文件，再以原子 `rename` 覆盖目标文件。虽然 Windows 的 `ReadDirectoryChangesW` 底层实际上挂在目录上，但 Linux `inotify` 对单文件 `fs.watch('.git/HEAD')` 在第一次 `rename` 更换 inode 后即失效。因此统一监听 `.git/` 目录（非递归），在回调中仅响应 `HEAD`、`packed-refs`、`index` 与 `worktrees`（忽略 `*.lock`、`*.new`、`objects`、`COMMIT_EDITMSG`、`AUTO_MERGE.lock` 等过程噪音）。
2. **递归监听 `.git/refs` 与动态监听 `.git/worktrees`**：
   - Node.js `>=20` 在 Windows、macOS、Linux 上均原生支持 `fs.watch(dir, { recursive: true })`。`.git/refs`（存放 `refs/heads/feat/nested/topic` 等嵌套引用）应使用 `{ recursive: true }`。
   - **实测 `ENOENT` 陷阱**：当仓库没有任何 linked `Worktree`（或最后一个 linked `Worktree` 被删除）时，Git 会**连带删除 `.git/worktrees/` 目录本身**，此时直接 `watch('.git/worktrees')` 会直接抛出 `ENOENT` 崩溃。正确做法是由 `.git/` 监听器在观察到 `filename === 'worktrees'` 且 `existsSync(worktreesDir)` 时再动态挂载 `{ recursive: true }` 监听器，并在其被删时卸载。
3. **强制 `--no-optional-locks` 打破自激循环**：
   - **实测复现**：当工作区某文件 `mtime` 发生变化但内容未改时，不带 `--no-optional-locks` 运行 `git status` 会主动生成 `index.lock` 并改写 `.git/index`（实测在 `.git` 监听器收到 `rename:index.lock`、`change:index.lock`、`rename:index` 等 5 条事件），从而再次触发状态刷新形成自激死循环。
   - 带上 `--no-optional-locks`（或环境变量 `GIT_OPTIONAL_LOCKS=0`，`git.html#L2472-L2480`）后，同一测试完全不再写入 `index.lock` / `index`。因此**所有后台只读查询命令必须默认携带 `--no-optional-locks` 与 `GIT_OPTIONAL_LOCKS=0`**。
4. **分层防抖与工作区监听节制**：
   - 仓库元数据通道（`.git` 的 `HEAD`/`packed-refs`、`.git/refs`、`.git/worktrees`）使用 `150ms`–`250ms` 防抖合并事件，仅刷新该 `Repository` 的图谱与 `Worktree[]` 列表。
   - 工作区文件监听器**仅挂载在当前 `Focused Worktree` 根目录下**（不监听所有未聚焦的 `Worktree`），过滤 `.git` 目录本身以及可选跳过 `node_modules` / 构建输出目录的高频事件，防抖窗口 `250ms`–`400ms` 并叠加最小刷新间隔（避免大型构建工具持续写文件时饿死刷新）。

### 4.2 Windows 目录句柄锁定与 `ReadDirectoryChangesW` 风暴防护

实测 `git worktree remove --force <wt>` 在 Windows 上暴露出两项严重隐患：

1. **进程 `cwd` 占用导致不可逆的半残删除**：
   - 实测当任意子进程或 Node 主进程自身 `process.cwd()` 位于目标 `Worktree` 目录内时，`git worktree remove --force` 返回退出码 `255` 与 `error: failed to delete '...': Permission denied`。
   - **更危险的后果**：失败之前 Git 已经先删除了 `<wt>/.git` 文件和 `.git/worktrees/<name>` 元数据；当占用进程退出后再次重试 `git worktree remove --force`，Git 会报退出码 `128`（`fatal: '...' is not a working tree`），留下只能人工/FS 清理的残留目录。
   - **硬性约束**：Sidecar 进程启动后**绝不可**把 `process.cwd()` 留在任何 `Workspace` / `Worktree` 内（遵循 `updater.mjs#L15-L25` 思路，保持在插件目录或安全目录，全部 Git 命令通过 `execFile` 的 `cwd` 参数或 `-C` 执行）；在 UI 触发删除 `Worktree` 前若检测到删除失败且目录内 `.git` 已消失，向用户明确提示是否有终端/编辑器/构建进程仍占用该目录。
2. **Windows `fs.watch` 删除目录时的事件风暴**：
   - **实测复现**：当 Node 持有 `fs.watch(wtPath, { recursive: true })` 或 `fs.watch(wtRoot, { recursive: true })` 句柄期间，被监听目录本身被 `git worktree remove` 删除时，虽然 `FILE_SHARE_DELETE` 允许目录删除成功，但 Windows `ReadDirectoryChangesW` 在句柄关闭前会陷入死循环风暴。实测 50ms 内工作区监听器触发 **`29,390` 次**事件，`.git/worktrees` 监听器 150ms 内触发 **`20,695+` 次** `rename:\\?\<path>` 事件，且不触发 `error` 事件。
   - **防护策略**：
     - 插件主动调用 `git worktree remove` 前，必须先关闭该 `Worktree` 上的所有 `fs.watch` 句柄（若是最后一个 linked `Worktree`，同时关闭 `.git/worktrees` 监听器）。
     - **所有 `fs.watch` 回调第一行强制加入自毁守卫**：`if (!existsSync(watchedDir) || (typeof filename === 'string' && filename.startsWith('\\\\?\\'))) { watcher.close(); return; }`。实测加入该守卫后，外部终端删除目录引起的回调次数从 2 万+ 次骤降为 `1`–`9` 次并立即安全退出。

### 4.3 并发锁作用域分离与 `index.lock` 竞争重试

实测验证：当主仓库存在 `.git/index.lock` 时，在主仓库运行 `git add` 失败退出码为 `128`（`fatal: Unable to create '.../.git/index.lock': File exists.`），而**同一时间在 linked `Worktree` 中运行 `git add` 仍正常返回 exit `0`**。原因在于每个 `Worktree` 各自持有独立的 `index`（主仓库在 `.git/index`，linked `Worktree` 在 `.git/worktrees/<name>/index`），而 `refs/`、`packed-refs`、`config`、`worktrees/` 与 `HEAD`（含分支独占检出检查）归属于整个 `Repository`（`gitCommonDir`）。

因此写操作应按两级队列串行化，不采用全局单锁也不盲目并发：

| 作用域 | 锁键值 | 适用命令 |
| --- | --- | --- |
| **Worktree 级写队列** | 规范化 `wt.path` | `add`、`reset -- <path>`、`restore`、`checkout -- <path>`、`clean` |
| **Repository 级写队列** | 规范化 `gitCommonDir` | `commit`、`checkout/switch`（改 `HEAD`）、`branch`、`merge`、`rebase`、`stash`、`worktree add/remove/lock/unlock/prune`、`fetch`、`pull`、`push` |
| **只读并发池** | 无写锁（受限于并发上限，如 `<= 4`） | 带 `--no-optional-locks` 的 `status`、`log`、`diff`、`show`、`worktree list`、`rev-parse` |

当写命令遭遇外部终端造成的瞬时锁冲突（stderr 匹配 `/Unable to create '.*\.lock': File exists\./`）时，允许按固定短退避重试 2–3 次（如 `80ms`、`200ms`、`400ms`）；若仍失败，直接将 Git 原文与锁文件路径展示给用户手动排查，**绝不自动删除用户的 `.lock` 文件**（防止破坏后台正在进行的 `commit`/`rebase` 事务）。

### 4.4 `fetch / pull / push` 非交互凭据防卡死契约

在本地 `127.0.0.1` 启动返回 `HTTP 401`（`WWW-Authenticate: Basic`）的测试服务，对默认启用系统级 `credential.helper=manager`（GCM 2.7.3）的 Windows Git 2.53.0 进行实测：

| 注入环境 / 参数 | 耗时 | 退出码 | 实测结果 |
| --- | --- | --- | --- |
| 仅 `GIT_TERMINAL_PROMPT=0` | `4007ms`（超时强杀） | `TIMEOUT` | **失败**：`GIT_TERMINAL_PROMPT=0` 无法阻止 Git Credential Manager 弹出/等待交互鉴权窗口 |
| `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never` | `1009ms` | `128` | **快速失败**：GCM 返回 `fatal: Cannot prompt because user interactivity has been disabled.` 且保留已缓存凭据正常生效 |
| 额外加 `-c credential.helper=` | `133ms` | `128` | 不推荐默认使用，会连带禁用系统里已存好的 HTTPS 凭据 |

**推荐网络命令（`fetch`、`pull`、`push`、`ls-remote`）统一环境变量契约**：

- `GIT_TERMINAL_PROMPT: '0'`
- `GCM_INTERACTIVE: 'never'`（兼容现代 GCM 文档的 `credential.interactive=false` 映射）
- `GIT_ASKPASS: ''`（禁用回退 GUI askpass 脚本）
- `SSH_ASKPASS_REQUIRE: 'never'`（OpenSSH 8.4+ 禁止拉起 `ssh-askpass`）
- 对 SSH 远端若需要确保未知主机指纹/加密私钥不挂起，可评估在用户未自定义 `GIT_SSH_COMMAND` 时注入 `ssh -o BatchMode=yes`（或将未完成交互的网络命令设置合理超时，如 30–60 秒），并在捕获 exit `128` 且 stderr 含交互/鉴权禁用报错时，引导用户在终端完成一次登录或通过 `window.sidecar.auth.requestCredentialRefresh()`（`sidecar_sdk/preload.js#L458-L460`）通知宿主。
