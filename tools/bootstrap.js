#!/usr/bin/env node
'use strict';
/**
 * 一条命令上手：给别的机器（或别人）用。
 *
 *   node tools/bootstrap.js             检测 → 扫描 → 打补丁（复用仓库里的译文）
 *   node tools/bootstrap.js --check     只看状态，不改任何文件
 *   node tools/bootstrap.js --with-ai   缺译文时顺带调用 DeepSeek 补翻（需 DEEPSEEK_API_KEY）
 *   node tools/bootstrap.js --force     即使已打过补丁也重跑一遍
 *
 * 译文库 data/translations.zh.json 按英文原文索引，所以换机器、换 Cursor 小版本都能复用，
 * 只有新增文案需要重新翻译。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PROJECT_ROOT, 'src', 'cli.js');
const has = (f) => process.argv.includes(f);
const line = (s) => console.log('\n' + s);

function run(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { stdio: 'inherit', cwd: PROJECT_ROOT });
  return res.status === 0;
}
function capture(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

if (!fs.existsSync(CLI)) {
  console.error('找不到 src/cli.js，请在项目根目录运行');
  process.exit(2);
}

line('① 检测 Cursor 安装');
const doctorArgs = has('--check') ? ['doctor', '--no-save'] : ['doctor'];
if (!run(doctorArgs)) {
  console.error('\n定位 Cursor 安装目录失败。可以显式指定：');
  console.error('  node src/cli.js doctor --app-dir="<Cursor>/resources/app"');
  process.exit(3);
}

line('② 当前状态');
run(['status']);

const snap = capture(['status', '--json']);
let st = null;
try { st = JSON.parse(snap.out); } catch { /* 解析失败就按未知处理 */ }

const needScan = !st || !st.sameVersion;
const needApply = !st || !st.patched || needScan;

if (has('--check')) {
  line('只做检查，未修改任何文件。');
  process.exit(0);
}
if (st && st.patched && !needScan && !has('--force')) {
  line(`已经是中文（${st.patched} 个文件哈希与落盘记录一致），没有需要做的事。`);
  console.log(`译文库 ${st.translations} 条；待翻译 ${st.pending === null ? '未知' : st.pending} 条。`);
  process.exit(0);
}

if (needScan) {
  line('③ 抽取候选文案（scan）');
  if (!run(['scan'])) process.exit(4);
} else {
  line('③ 快照与当前安装一致，跳过 scan');
}

line('④ 补翻译（可选）');
const hint = '没有配置 DeepSeek 密钥时，缺译文的条目保持英文，不影响补丁安全。';
if (has('--with-ai')) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log('未检测到 DEEPSEEK_API_KEY。' + hint);
    console.log('Windows 且已配置 Codex 的 DPAPI 密钥时，可改用：powershell -ExecutionPolicy Bypass -File tools\\run-translate.ps1');
  } else {
    const res = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'src', 'translate.js'), '--size=60', '--concurrency=5'], { stdio: 'inherit', cwd: PROJECT_ROOT });
    if (res.status !== 0) console.log('翻译阶段未全部成功，继续用现有译文打补丁。');
  }
} else {
  console.log('跳过（要补翻请加 --with-ai）。' + hint);
}

line('⑤ 校验 + 打补丁');
run(['verify']);
if (!run(['apply', '--force'])) {
  console.error('\n打补丁失败。若提示文件被占用，请完全退出 Cursor 后重试：');
  console.error('  node src/cli.js apply --force');
  process.exit(5);
}

line('⑥ 落盘审计');
run(['audit']);

line('完成。重启 Cursor 生效；要还原英文：node src/cli.js restore --force');
