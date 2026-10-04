'use strict';
/**
 * 文件读写、哈希、备份。
 *
 * Cursor（VS Code 内核）在 product.json 的 checksums 里用 **sha256 的 base64** 记录
 * 受保护文件的哈希；改过这些文件必须同步更新，否则启动时会提示安装已损坏。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

function sha256Base64(buf) {
  // Cursor/VS Code 的 product.json checksums 用无填充（无 '='）的 base64
  return crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readBuf(file) {
  return fs.readFileSync(file);
}

function writeBufAtomic(file, buf) {
  const tmp = file + '.zh-tmp-' + process.pid;
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
      const e = new Error(`写入被占用或拒绝：${file}\n请完全退出 Cursor 后重试（或改用 npm run apply 的 --from-quit 模式）。`);
      e.cause = err;
      throw e;
    }
    throw err;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function backupFile(file, backupDir, relName) {
  ensureDir(backupDir);
  const buf = readBuf(file);
  const out = path.join(backupDir, relName.replace(/[\\/]/g, '__') + '.gz');
  if (!fs.existsSync(out)) {
    fs.writeFileSync(out, zlib.gzipSync(buf, { level: 9 }));
  }
  return {
    file,
    relName,
    backupPath: out,
    sha256: sha256Hex(buf),
    size: buf.length,
  };
}

function restoreFromBackup(record) {
  const buf = zlib.gunzipSync(readBuf(record.backupPath));
  writeBufAtomic(record.file, buf);
  return { file: record.file, size: buf.length, sha256: sha256Hex(buf) };
}

module.exports = {
  sha256Base64, sha256Hex, readBuf, writeBufAtomic, ensureDir, backupFile, restoreFromBackup,
};
