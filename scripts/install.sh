#!/usr/bin/env bash
set -euo pipefail

# Antigravity 2.0 Git Graph 插件跨平台安装脚本（macOS / Linux）

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

TARGET_DIR="${HOME}/.gemini/config/plugins/antigravity-git-worktree"
MODE="copy"

usage() {
  cat <<'EOF'
用法: install.sh [--target-dir <目录>] [--link | --uninstall] [-h|--help]

选项:
  --target-dir <目录>  目标插件安装目录
                       (默认: ~/.gemini/config/plugins/antigravity-git-worktree)
  --link               创建指向源码仓库的符号链接
  --uninstall          安全移除已安装的目录或符号链接
  -h, --help           显示此帮助信息

Usage: install.sh [--target-dir <dir>] [--link | --uninstall] [-h|--help]

Options:
  --target-dir <dir>  Target plugin installation directory
                      (default: ~/.gemini/config/plugins/antigravity-git-worktree)
  --link              Create a symbolic link to the source repository
  --uninstall         Safely remove the installed directory or symbolic link
  -h, --help          Show this help message
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-dir)
      if [ "$#" -lt 2 ] || [ -z "${2}" ]; then
        echo "Error: --target-dir requires a non-empty directory path." >&2
        exit 1
      fi
      TARGET_DIR="$2"
      shift 2
      ;;
    --target-dir=*)
      TARGET_DIR="${1#--target-dir=}"
      if [ -z "$TARGET_DIR" ]; then
        echo "Error: --target-dir requires a non-empty directory path." >&2
        exit 1
      fi
      shift
      ;;
    --link)
      if [ "$MODE" = "uninstall" ]; then
        echo "Error: --link and --uninstall cannot be used together." >&2
        exit 1
      fi
      MODE="link"
      shift
      ;;
    --uninstall)
      if [ "$MODE" = "link" ]; then
        echo "Error: --link and --uninstall cannot be used together." >&2
        exit 1
      fi
      MODE="uninstall"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# 规范化目标路径并阻止对根目录、源码仓库自身或其祖先目录执行破坏性操作
normalize_target_path() {
  local raw="$1"
  if [ -z "$raw" ]; then
    echo "Error: Target directory must not be empty." >&2
    exit 1
  fi

  case "$raw" in
    "~")
      raw="${HOME}"
      ;;
    "~/"*)
      raw="${HOME}/${raw#~/}"
      ;;
  esac

  while [ "${#raw}" -gt 1 ] && [ "${raw%/}" != "$raw" ]; do
    raw="${raw%/}"
  done

  if [ "$raw" = "/" ]; then
    echo "Error: Refusing to operate on filesystem root '/'." >&2
    exit 1
  fi

  local parent base resolved_parent
  parent="$(dirname "$raw")"
  base="$(basename "$raw")"
  if [ -d "$parent" ]; then
    resolved_parent="$(cd "$parent" && pwd -P)"
    if [ "$resolved_parent" = "/" ]; then
      printf '/%s\n' "$base"
    else
      printf '%s/%s\n' "$resolved_parent" "$base"
    fi
  else
    case "$raw" in
      /*|[A-Za-z]:/*) printf '%s\n' "$raw" ;;
      *) printf '%s/%s\n' "$(pwd -P)" "$raw" ;;
    esac
  fi
}

# 安全移除目标路径：若为软链接仅删除链接本身，绝不递归删除链接指向的源仓库
remove_target_safely() {
  local target="$1"
  if [ -L "$target" ]; then
    rm -f "$target"
  elif [ -d "$target" ]; then
    rm -rf "$target"
  elif [ -e "$target" ]; then
    rm -f "$target"
  fi
}

is_excluded_name() {
  local name="$1"
  case "$name" in
    .git|docs|tests|scripts|README.md|README.zh-CN.md|tmp|.scratch|node_modules|.sidecar.pid|.DS_Store|Thumbs.db|desktop.ini|*.log)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# 按运行白名单规则递归复制目录内容并跳过非运行及临时产物
copy_filtered_dir() {
  local src_dir="$1"
  local dst_dir="$2"
  mkdir -p "$dst_dir"

  shopt -s dotglob nullglob
  local entry name
  for entry in "$src_dir"/*; do
    name="${entry##*/}"
    if is_excluded_name "$name"; then
      continue
    fi
    if [ -L "$entry" ]; then
      continue
    fi
    if [ -d "$entry" ]; then
      copy_filtered_dir "$entry" "$dst_dir/$name"
    elif [ -f "$entry" ]; then
      cp -p "$entry" "$dst_dir/$name"
    fi
  done
}

assert_safe_target() {
  local target="$1"
  if [ "$target" = "$REPO_ROOT" ]; then
    echo "Error: Refusing to overwrite or remove source repository directory: $target" >&2
    exit 1
  fi
  case "$REPO_ROOT" in
    "$target"/*)
      echo "Error: Refusing to operate on an ancestor directory of the source repository: $target" >&2
      exit 1
      ;;
  esac
}

assert_source_runtime_files() {
  local required
  for required in \
    "${REPO_ROOT}/plugin.json" \
    "${REPO_ROOT}/assets/logo.svg" \
    "${REPO_ROOT}/sidecars/panel/sidecar.json"; do
    if [ ! -f "$required" ]; then
      echo "Error: Required plugin runtime file not found: $required" >&2
      exit 1
    fi
  done
}

read_sidecar_pid() {
  local plugin_dir="$1"
  local pid_file="${plugin_dir}/.sidecar.pid"
  if [ ! -f "$pid_file" ]; then
    return 0
  fi

  local parsed_pid=""
  parsed_pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$pid_file" 2>/dev/null | head -n 1 || true)"
  if [[ "$parsed_pid" =~ ^[0-9]+$ ]] && [ "$parsed_pid" -gt 1 ] && [ "$parsed_pid" -ne "$$" ]; then
    printf '%s\n' "$parsed_pid"
  fi
}

stop_sidecar_pid() {
  local sidecar_pid="${1:-}"
  local pid_file="${2:-}"

  if [ -z "$sidecar_pid" ] || ! [[ "$sidecar_pid" =~ ^[0-9]+$ ]] || [ "$sidecar_pid" -le 1 ] || [ "$sidecar_pid" -eq "$$" ]; then
    return 0
  fi

  if ! kill -0 "$sidecar_pid" 2>/dev/null; then
    [ -n "$pid_file" ] && rm -f "$pid_file" 2>/dev/null || true
    return 0
  fi

  local comm=""
  comm="$(ps -p "$sidecar_pid" -o comm= 2>/dev/null | awk '{print $1}' || true)"
  local base_comm="${comm##*/}"
  if [ "$base_comm" != "node" ] && [ "$base_comm" != "nodejs" ]; then
    [ -n "$pid_file" ] && rm -f "$pid_file" 2>/dev/null || true
    return 0
  fi

  kill -TERM "$sidecar_pid" 2>/dev/null || true
  [ -n "$pid_file" ] && rm -f "$pid_file" 2>/dev/null || true
  printf '%s\n' "$sidecar_pid"
}

print_install_summary() {
  local zh_status="$1"
  local en_status="$2"
  local is_update="$3"
  local restarted_pid="${4:-}"
  local zh_hint en_hint

  if [ -n "$restarted_pid" ]; then
    zh_hint="已自动重启运行中的 \"Git Graph\" Sidecar（PID ${restarted_pid}），Antigravity 将自动加载新版本，无需手动开关插件（未修改 config.json）。"
    en_hint="Automatically restarted the running \"Git Graph\" sidecar (PID ${restarted_pid}); Antigravity will reload the updated version without toggling the plugin (config.json was not modified)."
  elif [ "$is_update" -eq 1 ]; then
    zh_hint='下一步：在 Antigravity Customizations 中先关闭再重新开启 "Git Graph"，以重新加载更新后的 Sidecar（未修改 config.json）。'
    en_hint='Next step: In Antigravity Customizations, toggle "Git Graph" off and back on to reload the updated sidecar (config.json was not modified).'
  else
    zh_hint='下一步：打开 Antigravity Customizations 并启用 "Git Graph"（未修改 config.json）。'
    en_hint='Next step: Open Antigravity Customizations and enable "Git Graph" (config.json was not modified).'
  fi

  printf '%s\n%s\n\n%s\n%s\n' "$zh_status" "$zh_hint" "$en_status" "$en_hint"
}

NORMALIZED_TARGET="$(normalize_target_path "$TARGET_DIR")"
assert_safe_target "$NORMALIZED_TARGET"

if [ "$MODE" = "uninstall" ]; then
  if [ -L "$NORMALIZED_TARGET" ] || [ -e "$NORMALIZED_TARGET" ]; then
    RUNNING_PID="$(read_sidecar_pid "$NORMALIZED_TARGET")"
    STOPPED_PID="$(stop_sidecar_pid "$RUNNING_PID" "${NORMALIZED_TARGET}/.sidecar.pid")"
    remove_target_safely "$NORMALIZED_TARGET"
    if [ -n "$STOPPED_PID" ]; then
      printf '%s\n%s\n\n%s\n%s\n' \
        "已停止运行中的 \"Git Graph\" Sidecar（PID ${STOPPED_PID}）" \
        "已卸载 \"Git Graph\" (antigravity-git-worktree)：${NORMALIZED_TARGET}" \
        "Stopped running 'Git Graph' sidecar (PID ${STOPPED_PID})" \
        "Uninstalled 'Git Graph' (antigravity-git-worktree) from: ${NORMALIZED_TARGET}"
    else
      printf '%s\n\n%s\n' \
        "已卸载 \"Git Graph\" (antigravity-git-worktree)：${NORMALIZED_TARGET}" \
        "Uninstalled 'Git Graph' (antigravity-git-worktree) from: ${NORMALIZED_TARGET}"
    fi
  else
    printf '%s\n\n%s\n' \
      "未在以下路径检测到已安装的 \"Git Graph\"：${NORMALIZED_TARGET}" \
      "Plugin 'Git Graph' is not installed at: ${NORMALIZED_TARGET}"
  fi
  exit 0
fi

assert_source_runtime_files

WAS_ALREADY_INSTALLED=0
RUNNING_PID=""
if [ -f "${NORMALIZED_TARGET}/plugin.json" ]; then
  WAS_ALREADY_INSTALLED=1
fi
if [ -d "$NORMALIZED_TARGET" ]; then
  RUNNING_PID="$(read_sidecar_pid "$NORMALIZED_TARGET")"
fi

mkdir -p "$(dirname "$NORMALIZED_TARGET")"
remove_target_safely "$NORMALIZED_TARGET"

if [ "$MODE" = "link" ]; then
  ln -s "$REPO_ROOT" "$NORMALIZED_TARGET"
  RESTARTED_PID="$(stop_sidecar_pid "$RUNNING_PID" "${NORMALIZED_TARGET}/.sidecar.pid")"
  print_install_summary \
    "已创建 \"Git Graph\" (antigravity-git-worktree) 符号链接：${NORMALIZED_TARGET} -> ${REPO_ROOT}" \
    "Linked 'Git Graph' (antigravity-git-worktree) symlink: ${NORMALIZED_TARGET} -> ${REPO_ROOT}" \
    "$WAS_ALREADY_INSTALLED" \
    "$RESTARTED_PID"
  exit 0
fi

mkdir -p "$NORMALIZED_TARGET"
cp -p "${REPO_ROOT}/plugin.json" "${NORMALIZED_TARGET}/plugin.json"
copy_filtered_dir "${REPO_ROOT}/assets" "${NORMALIZED_TARGET}/assets"
copy_filtered_dir "${REPO_ROOT}/sidecars/panel" "${NORMALIZED_TARGET}/sidecars/panel"

RESTARTED_PID="$(stop_sidecar_pid "$RUNNING_PID" "${NORMALIZED_TARGET}/.sidecar.pid")"
if [ "$WAS_ALREADY_INSTALLED" -eq 1 ]; then
  print_install_summary \
    "已更新 \"Git Graph\" (antigravity-git-worktree)：${NORMALIZED_TARGET}" \
    "Updated 'Git Graph' (antigravity-git-worktree) at: ${NORMALIZED_TARGET}" \
    1 \
    "$RESTARTED_PID"
else
  print_install_summary \
    "已将 \"Git Graph\" (antigravity-git-worktree) 安装至：${NORMALIZED_TARGET}" \
    "Installed 'Git Graph' (antigravity-git-worktree) to: ${NORMALIZED_TARGET}" \
    0 \
    "$RESTARTED_PID"
fi
