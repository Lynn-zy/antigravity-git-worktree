# Antigravity Git Worktree

用于管理 Antigravity 2.0 桌面端多仓库 Git Worktree、提交拓扑图与工作区变更的辅助栏扩展领域词汇表。

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

**Managed Worktree**:
由 Antigravity 桌面端自动创建并存放在用户配置工作树目录下的隔离 Worktree。
_Avoid_: Temp Worktree, Agent Folder

### 焦点与对话联动

**Focused Worktree**:
用户在面板中当前选定、作为拓扑图、远程同步与文件暂存还原操作目标的 Worktree。
_Avoid_: Active Workspace, Current Branch

**Conversation-Bound Worktree**:
检出目录命中当前 Antigravity 对话 Workspace 路径的 Worktree，可与 Focused Worktree 不同。
_Avoid_: Focused Worktree, Active Worktree, Linked Conversation

**Linked Conversation**:
与某个 Managed Worktree 一对一关联且仍存在的历史或并行 Antigravity 对话，可从面板直接切换过去。
_Avoid_: Conversation-Bound Worktree, History Chat

### 面板与变更视图

**Auxiliary Pane**:
Antigravity 2.0 桌面端右侧用于承载自定义插件面板的辅助视口。
_Avoid_: Sidebar, Chat Canvas

**Commit Graph**:
以提交节点拓扑连线、分支引用标签和可选未提交虚拟节点构成的 Repository 历史视图。
_Avoid_: Git Log, Timeline

**Working Tree Changes**:
指定 Focused Worktree 内尚未提交到本地分支的已暂存、未暂存和未跟踪文件变更集合。
_Avoid_: Diff, Patch
