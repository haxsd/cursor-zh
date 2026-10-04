'use strict';
/**
 * 定位 Cursor 安装目录、读取 product.json、判断版本与校验表。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CANDIDATE_INSTALL_DIRS = [
  'D:\\cursor\\cursor',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor'),
  'C:\\Program Files\\Cursor',
  'C:\\Program Files\\cursor',
  path.join(process.env.LOCALAPPDATA || '', 'cursor'),
];

function isAppDir(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, 'product.json')) &&
    fs.existsSync(path.join(dir, 'out', 'vs', 'workbench'));
}

/** 从 `where cursor` / cursor.cmd 反推安装目录 */
function fromCommandOnPath() {
  try {
    const out = execFileSync('where.exe', ['cursor'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      // <install>\resources\app\bin\cursor.cmd
      const m = p.replace(/\//g, '\\').match(/^(.*)\\resources\\app\\bin\\cursor\.(cmd|exe|bat)$/i);
      if (m) return path.join(m[1], 'resources', 'app');
    }
  } catch { /* ignore */ }
  return null;
}

/** 从注册表卸载项反推安装目录 */
function fromRegistry() {
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const key of keys) {
    let dump;
    try {
      dump = execFileSync('reg.exe', ['query', key, '/s', '/f', 'Cursor'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { continue; }
    const blocks = dump.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      if (!/DisplayName\s+REG_SZ\s+Cursor/i.test(block)) continue;
      const m = block.match(/InstallLocation\s+REG_SZ\s+(.+)/i);
      if (m) {
        const installDir = m[1].trim().replace(/\\+$/, '');
        const appDir = path.join(installDir, 'resources', 'app');
        if (isAppDir(appDir)) return appDir;
      }
    }
  }
  return null;
}

function readSavedConfig(projectRoot) {
  const cfgPath = path.join(projectRoot, 'work', 'config.json');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return cfg.appDir && isAppDir(cfg.appDir) ? cfg.appDir : null;
  } catch { return null; }
}

function resolveAppDir(projectRoot, explicit) {
  const tried = [];
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.CURSOR_APP_DIR) candidates.push(process.env.CURSOR_APP_DIR);
  candidates.push(readSavedConfig(projectRoot));
  candidates.push(fromCommandOnPath());
  candidates.push(fromRegistry());
  candidates.push(...CANDIDATE_INSTALL_DIRS.map(d => path.join(d, 'resources', 'app')));

  for (const c of candidates) {
    if (!c) continue;
    tried.push(c);
    if (isAppDir(c)) return { appDir: c, tried };
  }
  const err = new Error('找不到 Cursor 安装目录（resources/app）。已尝试：\n  ' + tried.join('\n  ') +
    '\n可用 --app-dir="D:\\cursor\\cursor\\resources\\app" 或环境变量 CURSOR_APP_DIR 指定。');
  err.tried = tried;
  throw err;
}

function loadProduct(appDir) {
  const productPath = path.join(appDir, 'product.json');
  const raw = fs.readFileSync(productPath, 'utf8');
  return { productPath, raw, product: JSON.parse(raw) };
}

function describe(appDir) {
  const { productPath, product } = loadProduct(appDir);
  return {
    appDir,
    installDir: path.dirname(path.dirname(appDir)),
    productPath,
    version: product.version,
    commit: product.commit,
    vscodeVersion: product.vscodeVersion,
    nameShort: product.nameShort,
    dataFolderName: product.dataFolderName,
    checksums: product.checksums || {},
  };
}

module.exports = { resolveAppDir, loadProduct, describe, isAppDir };
