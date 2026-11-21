# Antigravity Git Worktree

用于 Antigravity 2.0 桌面端辅助栏 Git 源代码管理与提交图表的领域词汇表。

## Language

### 工作区与仓库

**Workspace**:
当前 Antigravity 对话打开的一个或多个本地目录路径集合。
_Avoid_: Project, Repo

**Repository**:
拥有独立 Git 对象库与完整引用命名空间的本地仓库集合，同一 Workspace 内可包含零个或多个。
_Avoid_: Project, Folder, Workspace

**Worktree**:
关联到同一个 Repository 的独立检出目录，拥有各自的工作文件与 `HEAD` 状态，同时共享底层的对象与分支引用库。
_Avoid_: Workspace, Branch

### 面板与变更视图

**Auxiliary Pane**:
Antigravity 2.0 桌面端右侧用于承载自定义插件面板的辅助视口。
_Avoid_: Sidebar, Chat Canvas

**Commit Graph**:
以提交节点拓扑连线、分支引用标签和原地展开的文件列表构成的 Repository 历史视图。
_Avoid_: Git Log, Timeline

**Working Tree Changes**:
当前宿主 Workspace 命中的 Worktree 内尚未提交到本地分支的已暂存、未暂存与未跟踪文件变更集合。
_Avoid_: Diff, Patch
