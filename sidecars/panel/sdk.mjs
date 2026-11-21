import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * 动态加载官方 `sidecar_sdk` 模块，严禁在顶层静态导入，以便在无宿主的 Standalone 模式下正常运行。
 * 优先尝试原生 ESM `import('sidecar_sdk')`；失败时借助 `createRequire(import.meta.url).resolve('sidecar_sdk')`
 * 获取真实文件路径并转换为 `file://` URL 进行加载（兼容 NODE_PATH 解析）。
 *
 * @param {{ importFn?: (specifier: string) => Promise<unknown>, resolveFn?: (specifier: string) => string }} [options] 测试注入用的导入与解析函数
 * @returns {Promise<{ SidecarApp: Function, Response: Function }>} 加载后的 `sidecar_sdk` 模块命名空间
 */
export async function loadSidecarSdk(options = {}) {
  const importModule = options.importFn ?? ((specifier) => import(specifier));
  const resolveModule = options.resolveFn ?? ((specifier) => createRequire(import.meta.url).resolve(specifier));

  let esmError;
  try {
    const mod = await importModule('sidecar_sdk');
    if (mod && typeof mod.SidecarApp === 'function') {
      return mod;
    }
    esmError = new Error('Loaded sidecar_sdk module does not export SidecarApp.');
  } catch (error) {
    esmError = error;
  }

  try {
    const resolvedPath = resolveModule('sidecar_sdk');
    const fileUrl = resolvedPath.startsWith('file://')
      ? resolvedPath
      : pathToFileURL(resolvedPath).href;
    const mod = await importModule(fileUrl);
    if (!mod || typeof mod.SidecarApp !== 'function') {
      throw new Error('Resolved sidecar_sdk module does not export SidecarApp.');
    }
    return mod;
  } catch (fallbackError) {
    const esmReason = esmError instanceof Error ? esmError.message : String(esmError);
    const fallbackReason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
    throw new Error(
      `Failed to load sidecar_sdk (ESM: ${esmReason}; createRequire fallback: ${fallbackReason})`,
      { cause: fallbackError },
    );
  }
}
