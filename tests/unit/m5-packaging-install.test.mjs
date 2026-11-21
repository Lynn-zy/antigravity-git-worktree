import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 判断字节缓冲区是否以 UTF-8 BOM 开头。
 * @param {Buffer} buffer - 文件原始字节缓冲区。
 * @returns {boolean} 是否包含 UTF-8 BOM。
 */
const hasUtf8Bom = (buffer) =>
  buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;

/**
 * 规范化跨平台文件路径以便比较 Junction 目标是否指向预期源目录。
 * @param {string} rawPath - 原始文件系统路径。
 * @returns {string} 去除 \\?\ 前缀与末尾分隔符的规范路径。
 */
const normalizeComparablePath = (rawPath) => {
  const withoutDevicePrefix = rawPath.replace(/^\\\\\?\\/, '');
  const resolved = path.resolve(withoutDevicePrefix).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * 在临时目录构造模拟完整源码仓库夹具（含多层运行文件与应跳过产物）。
 * @param {string} fixtureRoot - 临时源码仓库根目录。
 * @returns {void} 无返回值；在磁盘写入测试所需源码树与哨兵文件。
 */
const createFixtureSourceRepo = (fixtureRoot) => {
  const write = (relPath, content) => {
    const fullPath = path.join(fixtureRoot, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  };

  write('plugin.json', fs.readFileSync(path.join(REPO_ROOT, 'plugin.json'), 'utf8'));
  write('assets/logo.svg', fs.readFileSync(path.join(REPO_ROOT, 'assets', 'logo.svg'), 'utf8'));
  write(
    'sidecars/panel/sidecar.json',
    fs.readFileSync(path.join(REPO_ROOT, 'sidecars', 'panel', 'sidecar.json'), 'utf8')
  );
  write('sidecars/panel/package.json', '{"type":"module","private":true}\n');
  write('sidecars/panel/main.mjs', 'export const boot = () => "ok";\n');
  write('sidecars/panel/backend/discovery.mjs', 'export const discover = () => [];\n');
  write('sidecars/panel/public/index.html', '<!doctype html><title>Git Graph</title>\n');
  write('sidecars/panel/public/modules/graph-layout.js', 'export const computeGraphTopology = () => [];\n');

  // 应被白名单拷贝显式跳过的非运行及临时产物
  write('.git/HEAD', 'ref: refs/heads/main\n');
  write('docs/spec.md', '# Spec\n');
  write('tests/unit/dummy.test.mjs', '// dummy test\n');
  write('README.md', '# Fixture README\n');
  write('src-sentinel.txt', 'KEEP_SOURCE_INTACT\n');
  write('sidecars/panel/debug.log', 'runtime noise\n');
  write('sidecars/panel/README.md', 'internal readme\n');
  write('sidecars/panel/tmp/cache.json', '{}');
  write('sidecars/panel/.scratch/notes.txt', 'scratch');
  write('sidecars/panel/node_modules/fake-pkg/index.js', 'module.exports = {};\n');

  fs.mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'install.ps1'),
    path.join(fixtureRoot, 'scripts', 'install.ps1')
  );
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'install.sh'),
    path.join(fixtureRoot, 'scripts', 'install.sh')
  );
};

/**
 * 断言测试夹具源码仓库中的关键文件与哨兵完好无损。
 * @param {string} fixtureRoot - 临时源码仓库根目录。
 * @returns {void} 无返回值；若任意源码文件丢失则抛出断言失败。
 */
const assertFixtureSourceIntact = (fixtureRoot) => {
  assert.equal(
    fs.readFileSync(path.join(fixtureRoot, 'src-sentinel.txt'), 'utf8'),
    'KEEP_SOURCE_INTACT\n'
  );
  assert.ok(fs.existsSync(path.join(fixtureRoot, '.git', 'HEAD')));
  assert.ok(fs.existsSync(path.join(fixtureRoot, 'docs', 'spec.md')));
  assert.ok(fs.existsSync(path.join(fixtureRoot, 'sidecars', 'panel', 'main.mjs')));
  assert.ok(fs.existsSync(path.join(fixtureRoot, 'sidecars', 'panel', 'backend', 'discovery.mjs')));
};

/**
 * 安全清理临时目录，优先拆除可能残留的符号链接或 Junction。
 * @param {string} dirPath - 待删除的临时根目录。
 * @param {string | null} [maybeLinkPath] - 可选的链接目标路径。
 * @returns {void} 无返回值；释放临时磁盘资源。
 */
const cleanupTempDir = (dirPath, maybeLinkPath = null) => {
  if (maybeLinkPath) {
    try {
      const stat = fs.lstatSync(maybeLinkPath);
      if (stat.isSymbolicLink()) {
        if (process.platform === 'win32') {
          fs.rmdirSync(maybeLinkPath);
        } else {
          fs.unlinkSync(maybeLinkPath);
        }
      }
    } catch {
      // 链接已被测试卸载时忽略
    }
  }
  fs.rmSync(dirPath, { recursive: true, force: true });
};

/**
 * 调用指定 PowerShell 可执行文件运行 install.ps1 并返回捕获结果。
 * @param {string} shellExe - PowerShell 可执行文件名（如 powershell.exe 或 pwsh）。
 * @param {string} scriptPath - install.ps1 文件路径。
 * @param {string[]} scriptArgs - 传递给 install.ps1 的参数列表。
 * @returns {{ status: number, stdout: string, stderr: string }} 退出码与标准流输出。
 */
const runPowershellInstaller = (shellExe, scriptPath, scriptArgs) => {
  try {
    const stdout = execFileSync(
      shellExe,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...scriptArgs],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout ? String(error.stdout) : '',
      stderr: error.stderr ? String(error.stderr) : error.message
    };
  }
};

/**
 * 检测当前系统上可用的非 WSL 存根 bash 可执行文件。
 * @returns {string | null} 可用 bash 命令路径，不存在时返回 null。
 */
const findWorkingBash = () => {
  const candidates =
    process.platform === 'win32'
      ? ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe']
      : ['bash'];

  for (const candidate of candidates) {
    try {
      const probe = execFileSync(candidate, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (probe.toLowerCase().includes('bash')) {
        return candidate;
      }
    } catch {
      // 忽略不存在或不可运行的候选路径
    }
  }
  return null;
};

/**
 * 检测系统中是否存在 PowerShell 7+（pwsh）。
 * @returns {boolean} 是否可运行 pwsh。
 */
const hasPwsh = () => {
  try {
    execFileSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return true;
  } catch {
    return false;
  }
};

test('plugin.json matches spec 8.1 and has no UTF-8 BOM', () => {
  const manifestPath = path.join(REPO_ROOT, 'plugin.json');
  const rawBytes = fs.readFileSync(manifestPath);
  assert.equal(hasUtf8Bom(rawBytes), false, 'plugin.json must not contain UTF-8 BOM');

  const manifest = JSON.parse(rawBytes.toString('utf8'));
  assert.equal(manifest.name, 'antigravity-git-worktree');
  assert.equal(manifest.displayName, 'Git Graph');
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(
    manifest.description,
    'VS Code-style Source Control and inline SVG Commit Graph in the Antigravity Auxiliary Pane.'
  );
  assert.equal(manifest.logo, 'assets/logo.svg');
  assert.equal(manifest.repository, 'https://github.com/Lynn-zy/antigravity-git-worktree');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, manifest.logo)), 'logo file must exist');
});

test('sidecars/panel/sidecar.json matches spec 8.1 and forbids unsafe keys/templates', () => {
  const sidecarPath = path.join(REPO_ROOT, 'sidecars', 'panel', 'sidecar.json');
  const rawBytes = fs.readFileSync(sidecarPath);
  assert.equal(hasUtf8Bom(rawBytes), false, 'sidecar.json must not contain UTF-8 BOM');

  const rawText = rawBytes.toString('utf8');
  assert.equal(rawText.includes('${HOME}'), false, 'sidecar.json must not use ${HOME}');
  assert.equal(rawText.includes('disable_sandbox'), false, 'sidecar.json must not disable sandbox');
  assert.equal(rawText.includes('agent_permissions'), false, 'sidecar.json must not include agent_permissions');

  const sidecar = JSON.parse(rawText);
  assert.equal(sidecar.command, 'node');
  assert.deepEqual(sidecar.args, ['--max-old-space-size=192', 'main.mjs']);
  assert.equal(sidecar.restart_policy, 'always');
  assert.equal(sidecar.display_name, 'Git Graph');
  assert.equal(
    sidecar.description,
    'Source Control and Commit Graph following the active conversation workspace.'
  );
  assert.equal(sidecar.has_web_ui, true);
  assert.deepEqual(sidecar.ui_config, {
    display_name: 'Git Graph',
    views: [
      {
        path: '/',
        entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
        title: 'Git Graph'
      }
    ]
  });
  assert.equal('sandbox' in sidecar, false);
});

test('assets/logo.svg is valid standalone vector SVG with zero external references', () => {
  const logoPath = path.join(REPO_ROOT, 'assets', 'logo.svg');
  const rawBytes = fs.readFileSync(logoPath);
  assert.equal(hasUtf8Bom(rawBytes), false, 'logo.svg should not contain UTF-8 BOM');

  const svgText = rawBytes.toString('utf8');
  assert.match(svgText, /^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>/);
  assert.match(svgText, /\bviewBox="[^"]+"/);
  assert.match(svgText, /<\/svg>\s*$/);
  assert.match(svgText, /<path\b/);
  assert.match(svgText, /<circle\b/);

  // 禁止任何外网或外部资源引用
  assert.doesNotMatch(svgText, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/i);
  assert.doesNotMatch(svgText, /<image\b/i);
  assert.doesNotMatch(svgText, /xlink:href/i);
  assert.doesNotMatch(svgText, /@import/i);
  assert.doesNotMatch(svgText, /url\(/i);
});

test(
  'scripts/install.ps1 works end-to-end on Windows (copy, overwrite, Junction -Link, safe overwrite, -Uninstall)',
  { skip: process.platform !== 'win32' },
  () => {
    const ps1Path = path.join(REPO_ROOT, 'scripts', 'install.ps1');
    const ps1Bytes = fs.readFileSync(ps1Path);
    assert.equal(hasUtf8Bom(ps1Bytes), true, 'install.ps1 must have a single UTF-8 BOM for PS 5.1 safety');
    assert.equal(
      ps1Bytes.subarray(3, 6).equals(Buffer.from([0xef, 0xbb, 0xbf])),
      false,
      'install.ps1 must not have duplicate BOM'
    );

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag_gw_ps1_'));
    const realTargetDir = path.join(tempRoot, 'real install target');
    const fixtureSrcDir = path.join(tempRoot, 'fixture-src');
    const fixtureTargetDir = path.join(tempRoot, 'plugins with space', 'antigravity-git-worktree');

    try {
      // 0. 静态 AST 验证默认 TargetDir 与参数定义（不触碰真实 ~/.gemini/config/）
      const astCheck = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${ps1Path.replace(/'/g, "''")}', [ref]$null, [ref]$null); $ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath + '=' + $_.DefaultValue.Extent.Text }`
        ],
        { encoding: 'utf8' }
      );
      assert.match(astCheck, /TargetDir=\(Join-Path \$home '\.gemini\\config\\plugins\\antigravity-git-worktree'\)/);
      assert.match(astCheck, /Link=/);
      assert.match(astCheck, /Uninstall=/);

      // 1. 直接针对真实仓库执行默认拷贝安装
      const realInstall = runPowershellInstaller('powershell.exe', ps1Path, [
        '-TargetDir',
        realTargetDir
      ]);
      assert.equal(realInstall.status, 0, realInstall.stderr);
      assert.match(realInstall.stdout, /Git Graph/);
      assert.match(realInstall.stdout, /Antigravity Customizations/);
      assert.equal(realInstall.stdout.includes('\uFFFD'), false, 'output must not contain replacement char');

      assert.ok(fs.existsSync(path.join(realTargetDir, 'plugin.json')));
      assert.ok(fs.existsSync(path.join(realTargetDir, 'assets', 'logo.svg')));
      assert.ok(fs.existsSync(path.join(realTargetDir, 'sidecars', 'panel', 'sidecar.json')));
      for (const excluded of ['.git', 'docs', 'tests', 'scripts', 'README.md', 'AGENTS.md', 'GLOSSARY.md']) {
        assert.equal(
          fs.existsSync(path.join(realTargetDir, excluded)),
          false,
          `${excluded} must not be copied`
        );
      }

      // 2. 在完整夹具仓库验证嵌套目录拷贝、过滤、二次覆盖、Junction -Link、安全覆盖与 -Uninstall
      createFixtureSourceRepo(fixtureSrcDir);
      const fixturePs1 = path.join(fixtureSrcDir, 'scripts', 'install.ps1');

      const copyInstall = runPowershellInstaller('powershell.exe', fixturePs1, [
        '-TargetDir',
        fixtureTargetDir
      ]);
      assert.equal(copyInstall.status, 0, copyInstall.stderr);
      assert.ok(fs.existsSync(path.join(fixtureTargetDir, 'plugin.json')));
      assert.ok(fs.existsSync(path.join(fixtureTargetDir, 'assets', 'logo.svg')));
      assert.ok(fs.existsSync(path.join(fixtureTargetDir, 'sidecars', 'panel', 'sidecar.json')));
      assert.ok(fs.existsSync(path.join(fixtureTargetDir, 'sidecars', 'panel', 'main.mjs')));
      assert.ok(fs.existsSync(path.join(fixtureTargetDir, 'sidecars', 'panel', 'backend', 'discovery.mjs')));
      assert.ok(
        fs.existsSync(path.join(fixtureTargetDir, 'sidecars', 'panel', 'public', 'modules', 'graph-layout.js'))
      );

      for (const skippedPath of [
        '.git',
        'docs',
        'tests',
        'scripts',
        'README.md',
        'src-sentinel.txt',
        'sidecars/panel/debug.log',
        'sidecars/panel/README.md',
        'sidecars/panel/tmp',
        'sidecars/panel/.scratch',
        'sidecars/panel/node_modules'
      ]) {
        assert.equal(
          fs.existsSync(path.join(fixtureTargetDir, skippedPath)),
          false,
          `excluded path ${skippedPath} must be skipped`
        );
      }

      // 3. 二次覆盖拷贝应清理旧残留文件并保留完整运行文件
      fs.writeFileSync(path.join(fixtureTargetDir, 'stale.txt'), 'old', 'utf8');
      const overwriteInstall = runPowershellInstaller('powershell.exe', fixturePs1, [
        '-TargetDir',
        fixtureTargetDir
      ]);
      assert.equal(overwriteInstall.status, 0, overwriteInstall.stderr);
      assert.equal(fs.existsSync(path.join(fixtureTargetDir, 'stale.txt')), false);
      assert.ok(fs.existsSync(path.join(fixtureTargetDir, 'sidecars', 'panel', 'main.mjs')));

      // 4. -Link 建立 Junction 指向夹具源码仓库
      const linkInstall = runPowershellInstaller('powershell.exe', fixturePs1, [
        '-TargetDir',
        fixtureTargetDir,
        '-Link'
      ]);
      assert.equal(linkInstall.status, 0, linkInstall.stderr);
      const linkStat = fs.lstatSync(fixtureTargetDir);
      assert.equal(linkStat.isSymbolicLink(), true, '-Link target must be a Junction/ReparsePoint');
      assert.equal(
        normalizeComparablePath(fs.readlinkSync(fixtureTargetDir)),
        normalizeComparablePath(fixtureSrcDir)
      );
      assertFixtureSourceIntact(fixtureSrcDir);

      // 5. 在目标为 Junction 时执行默认拷贝覆盖：必须只删 Junction 本身而保留源仓库完好
      const copyOverLink = runPowershellInstaller('powershell.exe', fixturePs1, [
        '-TargetDir',
        fixtureTargetDir
      ]);
      assert.equal(copyOverLink.status, 0, copyOverLink.stderr);
      assert.equal(fs.lstatSync(fixtureTargetDir).isSymbolicLink(), false);
      assert.ok(fs.existsSync(path.join(fixtureTargetDir, 'sidecars', 'panel', 'main.mjs')));
      assertFixtureSourceIntact(fixtureSrcDir);

      // 6. 再次 -Link 后执行 -Uninstall：仅移除 Junction，源码树保持完好
      const relink = runPowershellInstaller('powershell.exe', fixturePs1, [
        '-TargetDir',
        fixtureTargetDir,
        '-Link'
      ]);
      assert.equal(relink.status, 0, relink.stderr);
      assert.equal(fs.lstatSync(fixtureTargetDir).isSymbolicLink(), true);

      const uninstallLink = runPowershellInstaller('powershell.exe', fixturePs1, [
        '-TargetDir',
        fixtureTargetDir,
        '-Uninstall'
      ]);
      assert.equal(uninstallLink.status, 0, uninstallLink.stderr);
      assert.equal(fs.existsSync(fixtureTargetDir), false, 'Junction target must be removed');
      assertFixtureSourceIntact(fixtureSrcDir);

      // 7. 幂等卸载不存在目录应成功退出
      const uninstallMissing = runPowershellInstaller('powershell.exe', fixturePs1, [
        '-TargetDir',
        fixtureTargetDir,
        '-Uninstall'
      ]);
      assert.equal(uninstallMissing.status, 0, uninstallMissing.stderr);

      // 8. 参数互斥与源码防误删守卫
      const conflictFlags = runPowershellInstaller('powershell.exe', fixturePs1, [
        '-TargetDir',
        fixtureTargetDir,
        '-Link',
        '-Uninstall'
      ]);
      assert.notEqual(conflictFlags.status, 0);

      const selfTargetGuard = runPowershellInstaller('powershell.exe', fixturePs1, [
        '-TargetDir',
        fixtureSrcDir,
        '-Uninstall'
      ]);
      assert.notEqual(selfTargetGuard.status, 0);
      assertFixtureSourceIntact(fixtureSrcDir);

      // 9. 若安装有 pwsh（PowerShell 7+），顺带验证兼容执行
      if (hasPwsh()) {
        const pwshTarget = path.join(tempRoot, 'pwsh-target');
        const pwshInstall = runPowershellInstaller('pwsh', fixturePs1, [
          '-TargetDir',
          pwshTarget,
          '-Link'
        ]);
        assert.equal(pwshInstall.status, 0, pwshInstall.stderr);
        assert.equal(fs.lstatSync(pwshTarget).isSymbolicLink(), true);

        const pwshUninstall = runPowershellInstaller('pwsh', fixturePs1, [
          '-TargetDir',
          pwshTarget,
          '-Uninstall'
        ]);
        assert.equal(pwshUninstall.status, 0, pwshUninstall.stderr);
        assert.equal(fs.existsSync(pwshTarget), false);
        assertFixtureSourceIntact(fixtureSrcDir);
      }
    } finally {
      cleanupTempDir(tempRoot, fixtureTargetDir);
    }
  }
);

test('scripts/install.sh adheres to bash/LF/shebang/whitelist/symlink-safety rules and passes bash -n', () => {
  const shPath = path.join(REPO_ROOT, 'scripts', 'install.sh');
  const rawBytes = fs.readFileSync(shPath);
  assert.equal(hasUtf8Bom(rawBytes), false, 'install.sh must not contain UTF-8 BOM');
  assert.equal(rawBytes.includes(0x0d), false, 'install.sh must use LF line endings without CR');

  const shText = rawBytes.toString('utf8');
  assert.match(shText, /^#!\/usr\/bin\/env bash\n/);
  assert.match(shText, /^set -euo pipefail$/m);
  assert.match(shText, /--target-dir/);
  assert.match(shText, /--link/);
  assert.match(shText, /--uninstall/);
  assert.match(shText, /if \[ -L "\$target" \]; then\s+rm -f "\$target"/);
  assert.match(shText, /ln -s "\$REPO_ROOT" "\$NORMALIZED_TARGET"/);
  assert.match(shText, /plugin\.json/);
  assert.match(shText, /sidecars\/panel/);
  assert.match(shText, /node_modules/);
  assert.match(shText, /\.scratch/);
  assert.match(shText, /\*\.log/);
  assert.match(shText, /Antigravity Customizations/);
  assert.match(shText, /Git Graph/);
  assert.doesNotMatch(shText, /\.gemini\/config\/config\.json/);

  const bashExe = findWorkingBash();
  if (!bashExe) {
    return;
  }

  execFileSync(bashExe, ['-n', shPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // 使用可用 bash 实测含空格路径下的默认白名单拷贝与安全卸载
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag_gw_sh_'));
  const fixtureSrcDir = path.join(tempRoot, 'fixture src');
  const targetDir = path.join(tempRoot, 'sh target dir');

  try {
    createFixtureSourceRepo(fixtureSrcDir);
    const fixtureSh = path.join(fixtureSrcDir, 'scripts', 'install.sh').replace(/\\/g, '/');
    const targetArg = targetDir.replace(/\\/g, '/');

    const copyOut = execFileSync(bashExe, [fixtureSh, '--target-dir', targetArg], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.match(copyOut, /Git Graph/);
    assert.match(copyOut, /Antigravity Customizations/);
    assert.ok(fs.existsSync(path.join(targetDir, 'plugin.json')));
    assert.ok(fs.existsSync(path.join(targetDir, 'assets', 'logo.svg')));
    assert.ok(fs.existsSync(path.join(targetDir, 'sidecars', 'panel', 'main.mjs')));
    assert.equal(fs.existsSync(path.join(targetDir, 'docs')), false);
    assert.equal(fs.existsSync(path.join(targetDir, 'sidecars', 'panel', 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(targetDir, 'sidecars', 'panel', 'debug.log')), false);

    execFileSync(bashExe, [fixtureSh, '--target-dir', targetArg, '--uninstall'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(fs.existsSync(targetDir), false);
    assertFixtureSourceIntact(fixtureSrcDir);
  } finally {
    cleanupTempDir(tempRoot);
  }
});
