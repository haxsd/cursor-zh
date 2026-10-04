'use strict';
/**
 * 平台差异集中在这里。
 *
 * - Windows：改的是普通目录里的文件，改完即用；进程检测用 tasklist。
 * - macOS：Cursor.app 有代码签名，改了 Resources 里的文件签名就失效，必须重新 ad-hoc 签名，
 *   否则系统会直接拒绝启动（表现为"已损坏"或 zsh: killed）。签名前要先清隔离属性。
 * - Linux：普通目录，无特殊处理。
 */
const { execFileSync, spawnSync } = require('child_process');

function isCursorRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq Cursor.exe', '/NH'], { encoding: 'utf8' });
      return /Cursor\.exe/i.test(out);
    }
    const out = execFileSync('pgrep', ['-f', 'Cursor'], { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch {
    return false;   // pgrep 无匹配时退出码非 0
  }
}

/** 从 .../Cursor.app/Contents/Resources/app 反推 .app 路径 */
function appBundleFromAppDir(appDir) {
  const m = String(appDir).match(/^(.*\.app)[\\/]Contents[\\/]Resources[\\/]app[\\/]?$/);
  return m ? m[1] : null;
}

/**
 * 落盘后的平台收尾。返回给用户看的说明行数组。
 */
function postPatch(appDir, log) {
  const notes = [];
  if (process.platform !== 'darwin') return notes;
  const app = appBundleFromAppDir(appDir);
  if (!app) {
    notes.push('未识别出 .app 路径（安装目录不在 Cursor.app 内），跳过签名修复；若无法启动请手动执行：');
    notes.push('  xattr -cr <Cursor.app> && codesign --force --deep --sign - <Cursor.app>');
    return notes;
  }
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
  };
  const x = run('xattr', ['-cr', app]);
  notes.push(`清隔离属性：xattr -cr ${app} → ${x.ok ? 'ok' : '失败：' + x.out.slice(0, 160)}`);
  const c = run('codesign', ['--force', '--deep', '--sign', '-', app]);
  notes.push(`重新签名：codesign --force --deep --sign - ${app} → ${c.ok ? 'ok' : '失败：' + c.out.slice(0, 160)}`);
  if (c.ok) {
    const v = run('codesign', ['--verify', '--deep', '--strict', app]);
    notes.push(`签名校验：codesign --verify --deep --strict → ${v.ok ? 'ok' : '未通过：' + v.out.slice(0, 160)}`);
  } else {
    notes.push('签名失败会导致 Cursor 无法启动；请在有权限的终端里手动执行上面两条命令，或把 Cursor.app 装到 ~/Applications。');
  }
  return notes;
}

module.exports = { isCursorRunning, postPatch, appBundleFromAppDir };
