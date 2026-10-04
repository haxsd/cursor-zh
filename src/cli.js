'use strict';
/**
 * cursor-zh-hans CLI
 *
 *   doctor   定位安装目录、验证校验值算法与语法校验器
 *   scan     抽取候选文案并做安全分类 → data/candidates.json
 *   batch    生成翻译批次与 DeepSeek worker 作业文件 → work/batches, work/jobs.json
 *   merge    收集 worker 产物 → data/translations.zh.json
 *   verify   校验译文（占位符/完整性/术语） → reports/verify-report.md
 *   plan     dry-run：统计每个文件将要替换多少处
 *   apply    备份 → 替换 → 更新 product.json 校验值
 *   restore  从备份还原英文
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveAppDir, describe } = require('./lib/paths');
const F = require('./lib/files');
const P = require('./lib/platform');
const L = require('./lib/literals');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORK = path.join(PROJECT_ROOT, 'work');
const DATA = path.join(PROJECT_ROOT, 'data');
const REPORTS = path.join(PROJECT_ROOT, 'reports');

function arg(name, def) {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

function loadRules() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'rules.json'), 'utf8'));
}
function loadGlossary() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'glossary.json'), 'utf8'));
}
function readJson(file, def) {
  if (!fs.existsSync(file)) return def;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, obj) {
  F.ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 1));
}
function log(...a) { console.log(...a); }
/** 载入译文，并让人工修正表覆盖 API 译文 */
function loadTranslations() {
  const tr = readJson(path.join(DATA, 'translations.zh.json'), null);
  const ov = readJson(path.join(PROJECT_ROOT, 'config', 'overrides.json'), { text: {} });
  if (tr && ov && ov.text) {
    for (const [src, dst] of Object.entries(ov.text)) tr.byText[src] = dst;
  }
  return tr;
}
function targetPaths(appDir, rules, only) {
  const want = only && only !== true ? String(only).split(',') : null;
  return rules.targets
    .filter(t => !want || want.includes(t.label))
    .map(t => ({ ...t, abs: path.join(appDir, t.file) }));
}
/** product.json 里的 checksums 键相对 out/ 目录 */
function checksumKey(relFile) {
  return relFile.replace(/\\/g, '/').replace(/^out\//, '');
}
function validateSyntax(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err.stderr || err.message).slice(0, 4000) };
  }
}

// ─────────────────────────────── doctor ───────────────────────────────
function cmdDoctor() {
  const rules = loadRules();
  const { appDir } = resolveAppDir(PROJECT_ROOT, arg('app-dir', null) || null);
  const info = describe(appDir);
  const noSave = Boolean(arg('no-save', false));
  if (!noSave) F.ensureDir(WORK);
  const cfgPath = path.join(WORK, 'config.json');
  if (!noSave) writeJson(cfgPath, { appDir, savedAt: new Date().toISOString() });

  log(`Cursor       ${info.version}  (commit ${String(info.commit).slice(0, 10)})`);
  log(`VS Code 内核 ${info.vscodeVersion}`);
  log(`安装目录     ${info.installDir}`);
  log(`应用目录     ${info.appDir}`);
  log(`配置` + (noSave ? '（--no-save，未写盘）' : `已写入 ${cfgPath}`));
  log('');
  log('目标文件：');
  const out = [];
  for (const t of targetPaths(appDir, rules)) {
    if (!fs.existsSync(t.abs)) { log(`  ✗ ${t.label.padEnd(14)} 缺失 ${t.file}`); out.push({ label: t.label, present: false }); continue; }
    const buf = F.readBuf(t.abs);
    const ck = info.checksums[checksumKey(t.file)];
    const actual = F.sha256Base64(buf);
    let ckState = 'n/a';
    if (ck) ckState = ck === actual ? '校验值匹配 ✓' : `校验值不匹配 ✗ (product.json=${ck.slice(0, 12)}… 实测=${actual.slice(0, 12)}…)`;
    log(`  ✓ ${t.label.padEnd(14)} ${(buf.length / 1048576).toFixed(1)} MB  ${ckState}`);
    out.push({ label: t.label, file: t.file, present: true, bytes: buf.length, checksummed: Boolean(ck), checksumMatches: ck ? ck === actual : null });
  }
  log('');
  log('语法校验器（node --check）：');
  for (const t of targetPaths(appDir, rules)) {
    if (!fs.existsSync(t.abs)) continue;
    const v = validateSyntax(t.abs);
    log(`  ${v.ok ? '✓' : '✗'} ${t.label}${v.ok ? '' : '  ' + v.message.split('\n')[0]}`);
    out.find(o => o.label === t.label).syntaxCheck = v.ok;
  }
  log('');
  log(`Cursor 是否在运行：${P.isCursorRunning() ? '是（apply 前需要完全退出）' : '否'}`);
  if (!noSave) writeJson(path.join(REPORTS, 'doctor.json'), { ...info, targets: out, cursorRunning: P.isCursorRunning() });

  // 关键前提：校验值算法必须能被复现，否则不能改受保护文件
  const missing = out.filter(o => o.present && o.checksummed && !o.checksumMatches);
  if (missing.length) {
    log('');
    log('⚠ 有受保护文件的校验值与实测不一致，apply 时会拒绝改这些文件（除非 --allow-checksum-mismatch）。');
  }
  return 0;
}

// ─────────────────────────────── scan ───────────────────────────────
function cmdScan() {
  const rules = loadRules();
  const { appDir } = resolveAppDir(PROJECT_ROOT, arg('app-dir', null) || null);
  const info = describe(appDir);
  const targets = targetPaths(appDir, rules, arg('only', null));
  const merged = new Map();
  const fileStats = {};
  const nonAsciiByFile = {};

  for (const t of targets) {
    if (!fs.existsSync(t.abs)) { log(`跳过（缺失）：${t.file}`); continue; }
    const started = Date.now();
    const { entries, seen, nonAscii } = L.scanFile(t.abs, t.label, rules, { collectNonAscii: true });
    fileStats[t.label] = { file: t.file, bytes: fs.statSync(t.abs).size, literals: seen, values: entries.size, ms: Date.now() - started };
    nonAsciiByFile[t.label] = Object.fromEntries(nonAscii);
    log(`${t.label.padEnd(14)} 字面量 ${String(seen).padStart(7)}  去重 ${String(entries.size).padStart(6)}  自带非 ASCII ${String(nonAscii.size).padStart(5)}  ${((Date.now() - started) / 1000).toFixed(1)}s`);

    for (const [value, e] of entries) {
      let m = merged.get(value);
      if (!m) {
        m = { value, ui: 0, risky: 0, other: 0, props: {}, riskyKinds: {}, files: {}, sample: null };
        merged.set(value, m);
      }
      m.ui += e.ui; m.risky += e.risky; m.other += e.other;
      for (const [k, v] of Object.entries(e.props)) m.props[k] = (m.props[k] || 0) + v;
      for (const [k, v] of Object.entries(e.riskyKinds)) m.riskyKinds[k] = (m.riskyKinds[k] || 0) + v;
      if (!m.sample && e.sample) m.sample = e.sample;
      const rf = {};
      for (const [form, rec] of Object.entries(e.raw)) {
        rf[form] = { total: rec.total, ui: rec.ui.length, risky: rec.risky, other: rec.other, uiSpans: rec.ui, allSpans: rec.all };
      }
      m.files[t.label] = { raw: rf };
    }
  }

  const entries = Object.create(null);
  const counts = { auto: 0, context: 0, skip: 0, total: 0 };
  const byFile = {};
  for (const [value, m] of merged) {
    const { safety, natural } = L.classify(m);
    counts[safety]++;
    counts.total++;
    if (safety !== 'skip') {
      for (const [label, f] of Object.entries(m.files)) {
        byFile[label] = byFile[label] || { auto: 0, context: 0 };
        byFile[label][safety]++;
      }
    }
    // 替换区间：auto 用全部出现位置，context 只用 UI 上下文那几处
    for (const f of Object.values(m.files)) {
      for (const rec of Object.values(f.raw)) {
        rec.spans = safety === 'auto' ? rec.allSpans : rec.uiSpans;
        delete rec.allSpans;
        delete rec.uiSpans;
      }
    }
    entries[value] = {
      safety, natural,
      ui: m.ui, risky: m.risky, other: m.other,
      props: m.props, riskyKinds: m.riskyKinds,
      sample: m.sample,
      files: m.files,
    };
  }

  writeJson(path.join(DATA, 'candidates.json'), {
    generatedAt: new Date().toISOString(),
    appDir: info.appDir, version: info.version, commit: info.commit,
    fileStats, counts, entries, nonAscii: nonAsciiByFile,
  });

  log('');
  log(`合计去重文案 ${counts.total} 条：auto ${counts.auto} / context ${counts.context} / skip ${counts.skip}`);
  log('按文件（可替换条数）：');
  for (const [label, c] of Object.entries(byFile)) log(`  ${label.padEnd(14)} auto ${String(c.auto).padStart(5)}  context ${String(c.context).padStart(5)}`);
  log('');
  log(`已写入 data/candidates.json`);
  return 0;
}

// ─────────────────────────────── batch ───────────────────────────────
function cmdBatch() {
  const cand = readJson(path.join(DATA, 'candidates.json'), null);
  if (!cand) throw new Error('先运行 npm run scan');
  const size = Number(arg('size', 120));
  const priority = ['agent-window', 'editor-window', 'automations'];
  const items = Object.entries(cand.entries)
    .filter(([, e]) => e.safety !== 'skip')
    .map(([value, e]) => {
      const labels = Object.keys(e.files);
      const rank = Math.min(...labels.map(l => {
        const i = priority.indexOf(l);
        return i === -1 ? 99 : i;
      }));
      return { value, e, rank };
    })
    .sort((a, b) => a.rank - b.rank || b.e.ui - a.e.ui || a.value.localeCompare(b.value));

  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  const batchDir = path.join(WORK, 'batches');
  F.ensureDir(batchDir);

  const manifest = [];
  batches.forEach((batch, idx) => {
    const id = String(idx + 1).padStart(3, '0');
    const rows = batch.map(({ value, e }, n) => ({
      id: `${id}-${String(n + 1).padStart(3, '0')}`,
      text: value,
      prop: e.sample ? e.sample.prop : Object.keys(e.props)[0] || '',
      where: Object.keys(e.files).join('+'),
      ctx: e.sample ? `${e.sample.before} ⟦HERE⟧ ${e.sample.after}` : '',
    }));
    const file = path.join(batchDir, `batch-${id}.json`);
    fs.writeFileSync(file, '[\n' + rows.map(r => JSON.stringify(r)).join(',\n') + '\n]\n');
    manifest.push({ id: `zh-${id}`, batchFile: `work/batches/batch-${id}.json`, outFile: `work/translated/batch-${id}.zh.json`, count: rows.length });
  });

  const glossary = loadGlossary();
  const glossaryText = Object.entries(glossary.terms).map(([en, zh]) => `${en}=${zh}`).join('；');
  const keepText = glossary.keep.join(', ');
  writeJson(path.join(WORK, 'jobs.json'), {
    jobs: manifest.map(m => ({
      id: m.id,
      task: `把 ${m.batchFile} 里每一条 text 翻译成简体中文，写出一份只含 id→译文 的 JSON 对象到 ${m.outFile}。`,
      acceptance: '输出必须是合法 JSON 对象；输入里每个 id 都要出现且只出现一次；不得保留整句英文（专有名词除外）；占位符 {0} {1} $(icon) 和 \\n 必须原样保留；不要翻译 URL、文件路径、代码标识符。',
      context: `界面上下文：这是 Cursor 编辑器（基于 VS Code）的内置界面文案，主要来自 Agent 窗口、Cursor 设置页和 Automations 页面。翻译要短、像产品界面用语，不要口语化冗余。\n必须沿用的术语：${glossaryText}\n保持原文不译：${keepText}\nJSON 里 prop 字段指示该文案出现在什么位置（label=按钮/菜单标签，description=说明，placeholder=输入框提示，tooltip=悬浮提示，title=标题），where 字段指示来自哪个界面，ctx 字段是源码里的前后文（⟦HERE⟧ 标记当前句），用于消歧，不要翻译 ctx。`,
      files: [m.batchFile],
      writable: [m.outFile],
      checks: [],
    })),
  });

  log(`已生成 ${manifest.length} 个批次（每批 ≤ ${size} 条），共 ${items.length} 条可译文案`);
  log(`作业文件：work/jobs.json`);
  log(`批次目录：work/batches/`);
  return 0;
}

// ─────────────────────────────── merge ───────────────────────────────
function findWorkerOutputs(dir) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 6 || !fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/\.zh\.json$/i.test(name)) found.push(p);
    }
  };
  walk(dir, 0);
  return found;
}

function cmdMerge() {
  const outRoot = arg('from', null) || path.join(WORK, 'worker');
  const files = findWorkerOutputs(String(outRoot));
  if (!files.length) throw new Error(`在 ${outRoot} 下找不到 *.zh.json`);
  const cand = readJson(path.join(DATA, 'candidates.json'), null);
  if (!cand) throw new Error('先运行 npm run scan');
  const translations = readJson(path.join(DATA, 'translations.zh.json'), { generatedAt: null, byId: {}, byText: {} });
  translations.byId = translations.byId || {};
  translations.byText = translations.byText || {};

  // 批次清单给出 id → 原文 的映射
  const idToText = {};
  const batchDir = path.join(WORK, 'batches');
  for (const f of fs.existsSync(batchDir) ? fs.readdirSync(batchDir) : []) {
    if (!/^batch-.*\.json$/.test(f)) continue;
    const rows = JSON.parse(fs.readFileSync(path.join(batchDir, f), 'utf8'));
    for (const r of rows) idToText[r.id] = r.text;
  }

  let added = 0, updated = 0, unknown = 0, bad = 0;
  for (const file of files) {
    let obj;
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { bad++; log(`✗ 解析失败：${file}`); continue; }
    for (const [id, text] of Object.entries(obj)) {
      if (typeof text !== 'string' || !text.trim()) { bad++; continue; }
      const src = idToText[id];
      if (!src) { unknown++; continue; }
      if (translations.byId[id] && translations.byId[id].source === src) {
        if (translations.byId[id].target !== text) { updated++; }
      } else if (translations.byId[id]) {
        updated++;
      } else {
        added++;
      }
      translations.byId[id] = { source: src, target: text, file: path.relative(PROJECT_ROOT, file) };
      translations.byText[src] = text;
    }
  }
  translations.generatedAt = new Date().toISOString();
  writeJson(path.join(DATA, 'translations.zh.json'), translations);
  log(`合并完成：新增 ${added}，更新 ${updated}，无法归属 ${unknown}，格式错误 ${bad}`);
  log(`总计已有译文 ${Object.keys(translations.byText).length} 条，来自 ${files.length} 个文件`);
  return 0;
}

// ─────────────────────────────── verify ───────────────────────────────
const PLACEHOLDER_RE = /\{\d+\}|\$\([a-zA-Z0-9~-]+\)|%[sd]|\\n|\\u\{[0-9A-Fa-f]{1,6}\}|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}/g;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D]/gu;
const emojiCount = (s) => { const m = s.match(EMOJI_RE); return m ? m.length : 0; };

function cmdVerify() {
  const cand = readJson(path.join(DATA, 'candidates.json'), null);
  const tr = loadTranslations();
  if (!cand || !tr) throw new Error('先运行 scan / merge');
  const glossary = loadGlossary();
  const problems = { missing: [], empty: [], placeholder: [], untranslated: [], glossary: [], glossarySoft: [], tooLong: [] };
  const glossaryMap = new Map();
  for (const [en, zh] of Object.entries(glossary.terms)) {
    if (['Agent', 'Agents'].includes(en)) continue;
    if (!glossaryMap.has(en)) glossaryMap.set(en, zh);
  }
  let checked = 0;
  for (const [value, e] of Object.entries(cand.entries)) {
    if (e.safety === 'skip') continue;
    checked++;
    const t = tr.byText[value];
    if (!t) { problems.missing.push(value); continue; }
    if (!t.trim()) { problems.empty.push(value); continue; }
    const srcPh = (value.match(PLACEHOLDER_RE) || []).sort().join('|');
    const dstPh = (t.match(PLACEHOLDER_RE) || []).sort().join('|');
    if (srcPh !== dstPh) problems.placeholder.push({ source: value, target: t, srcPh, dstPh });
    if (emojiCount(value) > 0 && emojiCount(t) === 0) problems.placeholder.push({ source: value, target: t, srcPh: 'emoji×' + emojiCount(value), dstPh: 'emoji×0' });
    if (t === value && value.length > 3) problems.untranslated.push(value);
    // 术语一致性：原文含术语 A，译文应含对应译名
    for (const [en, zh] of glossaryMap.entries()) {
      const re = new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (re.test(value) && !t.includes(zh) && !glossary.keep.includes(en)) {
        problems.glossarySoft.push({ source: value, target: t, term: en, expect: zh });
      }
    }
    if (t.length > value.length * 3 + 12) problems.tooLong.push({ source: value, target: t });
  }
  const md = [];
  md.push('# 译文校验报告', '', `- 生成时间：${new Date().toISOString()}`, `- 可译文案：${checked} 条`, `- 已有译文：${Object.keys(tr.byText).length} 条`, '');
  const section = (title, list, fmt) => {
    md.push(`## ${title}（${list.length}）`, '');
    if (!list.length) { md.push('无', ''); return; }
    for (const item of list.slice(0, 200)) md.push('- ' + (fmt ? fmt(item) : String(item)));
    if (list.length > 200) md.push(`- …还有 ${list.length - 200} 条`);
    md.push('');
  };
  section('缺少译文', problems.missing);
  section('空译文', problems.empty);
  section('占位符不一致（硬错误）', problems.placeholder, p => `\`${p.source}\` → \`${p.target}\`（${p.srcPh} vs ${p.dstPh}）`);
  section('与原文相同（可能漏译）', problems.untranslated);
  section('术语偏离（提示）', problems.glossarySoft.slice(0, 60), p => `\`${p.source}\` → \`${p.target}\`  期望含「${p.expect}」`);
  section('译文过长（提示）', problems.tooLong, p => `\`${p.source}\` → \`${p.target}\``);
  F.ensureDir(REPORTS);
  fs.writeFileSync(path.join(REPORTS, 'verify-report.md'), md.join('\n'));
  log(`校验 ${checked} 条：缺译文 ${problems.missing.length}，占位符错误 ${problems.placeholder.length}，疑似漏译 ${problems.untranslated.length}，术语提示 ${problems.glossarySoft.length}，过长 ${problems.tooLong.length}`);
  log('报告：reports/verify-report.md');
  return problems.placeholder.length || problems.missing.length ? 1 : 0;
}

// ─────────────────────────────── plan / apply ───────────────────────────────
function buildPlan() {
  const cand = readJson(path.join(DATA, 'candidates.json'), null);
  const tr = loadTranslations();
  if (!cand || !tr) throw new Error('先运行 scan / merge');
  const rules = loadRules();
  const plan = [];
  for (const t of rules.targets) {
    const items = [];
    for (const [value, e] of Object.entries(cand.entries)) {
      if (e.safety === 'skip') continue;
      const target = tr.byText[value];
      if (!target) continue;
      const f = e.files[t.label];
      if (!f) continue;
      let replacements = 0;
      for (const rec of Object.values(f.raw)) {
        replacements += (rec.spans || []).length;
      }
      if (!replacements || target === value) continue;   // no-op 不替换
      items.push({ value, target, safety: e.safety, replacements });
    }
    plan.push({ label: t.label, file: t.file, items, total: items.reduce((s, i) => s + i.replacements, 0) });
  }
  return { cand, tr, plan };
}

function cmdPlan() {
  const { plan } = buildPlan();
  const md = ['# 替换计划（dry-run）', ''];
  for (const p of plan) {
    log(`${p.label.padEnd(14)} ${String(p.items.length).padStart(6)} 条文案，${String(p.total).padStart(7)} 处替换`);
    md.push(`## ${p.label}（${p.file}）`, '', `- 文案 ${p.items.length} 条，替换 ${p.total} 处`, '');
    md.push('| 原文 | 译文 | 安全级 | 处数 |', '| --- | --- | --- | --- |');
    for (const i of p.items.slice(0, 40)) md.push(`| ${i.value.replace(/\|/g, '\\|')} | ${i.target.replace(/\|/g, '\\|')} | ${i.safety} | ${i.replacements} |`);
    if (p.items.length > 40) md.push(`| … | 还有 ${p.items.length - 40} 条 | | |`);
    md.push('');
  }
  F.ensureDir(REPORTS);
  fs.writeFileSync(path.join(REPORTS, 'plan.md'), md.join('\n'));
  log('明细：reports/plan.md');
  return 0;
}

function escapeForLiteral(text) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'");
}

function patchText(src, entries, label) {
  const edits = [];
  for (const [value, e] of entries) {
    if (!e.__target || e.__target === e.value) continue;   // no-op 不动，避免把 \u2192 改写成 →
    const f = e.files[label];
    if (!f) continue;
    for (const [form, rec] of Object.entries(f.raw)) {
      const spans = rec.spans || [];
      if (!spans.length) continue;
      const quote = form[0];
      const repl = quote + escapeForLiteral(e.__target) + quote;
      for (const start of spans) edits.push({ start, end: start + form.length, repl, kind: e.safety, form });
    }
  }
  // 去重并处理重叠：按起点升序，重叠时保留更长的那个（通常是最外层真实字面量）
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const ed of edits) {
    const prev = kept[kept.length - 1];
    if (prev && ed.start < prev.end) {
      if (ed.end - ed.start > prev.end - prev.start) kept[kept.length - 1] = ed;
      continue;
    }
    kept.push(ed);
  }
  let out = src;
  let positional = 0, global = 0;
  const details = [];
  for (let i = kept.length - 1; i >= 0; i--) {
    const ed = kept[i];
    out = out.slice(0, ed.start) + ed.repl + out.slice(ed.end);
    if (ed.kind === 'auto') global++; else positional++;
  }
  if (positional) details.push(`位置替换 ${positional} 处`);
  if (global) details.push(`全局替换 ${global} 处`);
  return { text: out, positional, global, details };
}

function cmdApply() {
  const rules = loadRules();
  const { appDir } = resolveAppDir(PROJECT_ROOT, arg('app-dir', null) || null);
  const info = describe(appDir);
  const { cand, plan } = buildPlan();
  const tr = loadTranslations();
  const running = P.isCursorRunning();
  if (running && !arg('force', false)) {
    log('Cursor 正在运行。请完全退出 Cursor 后重试（或用 --force 尝试热替换，重启后生效）。');
    return 2;
  }

  const backupDir = path.join(WORK, 'backups', String(info.commit).slice(0, 12));
  const manifest = { appliedAt: new Date().toISOString(), version: info.version, commit: info.commit, appDir, files: [], product: null };

  // 安全门禁：替换坐标来自 candidates.json 的扫描结果，版本或文件大小不一致就不能用
  if (cand.commit !== info.commit && !arg('allow-stale', false)) {
    throw new Error(`替换坐标来自 Cursor ${cand.version}（commit ${String(cand.commit).slice(0, 10)}），当前安装是 ${info.version}（commit ${String(info.commit).slice(0, 10)}）。\n请先重新扫描：node src/cli.js scan（再跑 translate 补新文案），然后 apply。`);
  }
  for (const t of targetPaths(appDir, rules)) {
    const stat = cand.fileStats && cand.fileStats[t.label];
    if (!stat || !fs.existsSync(t.abs)) continue;
    const actual = fs.statSync(t.abs).size;
    if (stat.bytes !== actual) {
      throw new Error(`${t.file} 的大小与扫描时不一致（扫描 ${stat.bytes} 字节，现在 ${actual} 字节）。\n请重新扫描：node src/cli.js scan。`);
    }
  }

  // 先把每个条目的译文挂上，方便 patchText 使用
  const entries = Object.entries(cand.entries).map(([value, e]) => [value, { ...e, __target: tr.byText[value] }]);

  let totalReplacements = 0;
  const productPath = path.join(appDir, 'product.json');
  const productBuf = F.readBuf(productPath);
  const product = JSON.parse(productBuf.toString('utf8'));
  let productChanged = false;

  for (const t of targetPaths(appDir, rules)) {
    if (!fs.existsSync(t.abs)) continue;
    const src = fs.readFileSync(t.abs, 'utf8');
    const patched = patchText(src, entries, t.label);
    if (!patched.positional && !patched.global) { log(`${t.label.padEnd(14)} 无需替换`); continue; }

    const tmp = t.abs + '.zh-check.js';
    fs.writeFileSync(tmp, patched.text, 'utf8');
    const v = validateSyntax(tmp);
    if (!v.ok) {
      fs.unlinkSync(tmp);
      throw new Error(`${t.file} 替换后语法校验失败，已中止（原文件未动）：\n${v.message}`);
    }
    fs.unlinkSync(tmp);

    const rec = F.backupFile(t.abs, backupDir, t.file);
    rec.replacements = patched.positional + patched.global;
    rec.details = patched.details;
    rec.newSha256 = F.sha256Hex(Buffer.from(patched.text, 'utf8'));
    F.writeBufAtomic(t.abs, Buffer.from(patched.text, 'utf8'));
    manifest.files.push(rec);
    totalReplacements += rec.replacements;
    log(`${t.label.padEnd(14)} 已替换 ${String(rec.replacements).padStart(6)} 处  ${patched.details.join('，')}`);

    const ckKey = checksumKey(t.file);
    if (product.checksums && Object.prototype.hasOwnProperty.call(product.checksums, ckKey)) {
      const before = product.checksums[ckKey];
      const after = F.sha256Base64(Buffer.from(patched.text, 'utf8'));
      if (before !== after) {
        product.checksums[ckKey] = after;
        productChanged = true;
        log(`   ↳ 已更新 product.json 校验值 ${before.slice(0, 10)}… → ${after.slice(0, 10)}…`);
      }
    }
  }

  if (productChanged) {
    const pback = F.backupFile(productPath, backupDir, 'product.json');
    manifest.product = pback;
    F.writeBufAtomic(productPath, Buffer.from(JSON.stringify(product, null, '\t'), 'utf8'));
    log('product.json 已更新并备份');
  }

  // macOS：改动 .app 内的文件会使代码签名失效，必须重新 ad-hoc 签名，否则系统拒绝启动
  if (process.platform === 'darwin') {
    log('');
    log('平台收尾（macOS 签名）：');
    for (const note of P.postPatch(appDir, log)) log('  ' + note);
  }
  writeJson(path.join(WORK, 'applied.json'), manifest);
  log('');
  log(`完成：共替换 ${totalReplacements} 处，涉及 ${manifest.files.length} 个文件`);

  // 落盘后审计：字面量清单必须与计划完全一致
  const candData = readJson(path.join(DATA, 'candidates.json'), null);
  let auditBad = 0;
  for (const rec of manifest.files) {
    const label = (rules.targets.find(t => t.file === rec.relName) || {}).label;
    if (!label) continue;
    const r = auditFile(appDir, rules, candData, label);
    log(`审计 ${label.padEnd(14)} ${r.ok ? '✓ 一致' : `✗ 差异 ${r.mismatchCount} 处（详见 reports/audit.md）`}`);
    if (!r.ok) auditBad++;
  }
  log(`备份：${backupDir}`);
  if (auditBad) {
    log('');
    log('⚠ 审计发现差异，建议先 npm run restore 还原，回报后再分析。');
    return 1;
  }
  log('重启 Cursor 生效（完全退出后重新打开）。');
  return 0;
}

// ─────────────────────────────── audit ───────────────────────────────
/**
 * 落盘后的字面量清单审计。
 * 期望：改完后每个字面量的出现次数 == 原始次数 - 被替换次数；译文出现次数 == 被替换次数。
 * 任何其他差异都说明替换越界了。
 */
function auditFile(appDir, rules, cand, label) {
  const target = rules.targets.find(t => t.label === label);
  const abs = path.join(appDir, target.file);
  if (!fs.existsSync(abs)) return { label, ok: false, reason: '文件不存在' };
  const scanned = L.scanFile(abs, label, rules, { includeCJK: true }).entries;
  const scannedCount = new Map();
  for (const [v, e] of scanned) scannedCount.set(v, e.ui + e.risky + e.other);

  const expected = new Map();
  const tr = loadTranslations();
  for (const [value, e] of Object.entries(cand.entries)) {
    const f = e.files[label];
    if (!f) continue;
    let total = 0;
    for (const rec of Object.values(f.raw)) total += rec.total;
    let replaced = 0;
    const t = tr.byText[value];
    if (e.safety !== 'skip' && t && t !== value) {
      for (const rec of Object.values(f.raw)) replaced += (rec.spans || []).length;
    }
    expected.set(value, (expected.get(value) || 0) + (total - replaced));
    if (replaced) expected.set(t, (expected.get(t) || 0) + replaced);
  }
  // 原文自带的非 ASCII 字面量（Cursor 自己的多语言文案）不计入翻译，但要算进期望值
  const nonAscii = (cand.nonAscii && cand.nonAscii[label]) || {};
  for (const [v, n] of Object.entries(nonAscii)) {
    if (v.length < rules.limits.minLength) continue;
    expected.set(v, (expected.get(v) || 0) + n);
  }

  const mismatches = [];
  const allKeys = new Set([...expected.keys(), ...scannedCount.keys()]);
  for (const k of allKeys) {
    if (k.length < rules.limits.minLength) continue;              // 扫描器本身不统计单字符字面量
    if (!expected.has(k) && !/^[\x20-\x7E]*$/.test(k)) continue;  // 未在模型内的非 ASCII 字面量：原文残留，跳过
    const want = expected.get(k) || 0;
    const got = scannedCount.get(k) || 0;
    if (want !== got) mismatches.push({ value: k, expected: want, actual: got });
  }
  mismatches.sort((a, b) => Math.abs(b.expected - b.actual) - Math.abs(a.expected - a.actual));
  const totalLiterals = [...scannedCount.values()].reduce((s, n) => s + n, 0);
  return { label, file: target.file, ok: mismatches.length === 0, checked: expected.size, totalLiterals, mismatches: mismatches.slice(0, 40), mismatchCount: mismatches.length };
}

function cmdAudit() {
  const rules = loadRules();
  const { appDir } = resolveAppDir(PROJECT_ROOT, arg('app-dir', null) || null);
  const cand = readJson(path.join(DATA, 'candidates.json'), null);
  if (!cand) throw new Error('先运行 scan');
  let bad = 0;
  const md = ['# 落盘审计', ''];
  for (const t of rules.targets) {
    const r = auditFile(appDir, rules, cand, t.label);
    log(`${r.label.padEnd(14)} ${r.ok ? '✓ 一致' : `✗ 有 ${r.mismatchCount} 处差异`}  (核对 ${r.checked} 条文案，文件内字面量 ${r.totalLiterals})`);
    for (const m of (r.mismatches || []).slice(0, 10)) log(`    ${JSON.stringify(m.value)} 期望 ${m.expected} 实际 ${m.actual}`);
    md.push(`## ${r.label}`, '', r.ok ? '一致 ✓' : `差异 ${r.mismatchCount} 处`, '');
    for (const m of (r.mismatches || []).slice(0, 40)) md.push(`- \`${m.value}\` 期望 ${m.expected}，实际 ${m.actual}`);
    md.push('');
    if (!r.ok) bad++;
  }
  F.ensureDir(REPORTS);
  fs.writeFileSync(path.join(REPORTS, 'audit.md'), md.join('\n'));
  return bad ? 1 : 0;
}

// ─────────────────────────────── status ───────────────────────────────
/** 一眼看清：装在哪、什么版本、补丁在不在、还差多少译文、下一步做什么 */
function cmdStatus() {
  const rules = loadRules();
  const { appDir } = resolveAppDir(PROJECT_ROOT, arg('app-dir', null) || null);
  const info = describe(appDir);
  const cand = readJson(path.join(DATA, 'candidates.json'), null);
  const tr = loadTranslations();

  // 补丁是否在：优先用落盘记录里的新哈希核对，没有记录时退回探针字符串
  const applied = readJson(path.join(WORK, 'applied.json'), null);
  let patched = 0;
  let patchedHow = '';
  if (applied && applied.commit === info.commit && Array.isArray(applied.files)) {
    for (const rec of applied.files) {
      if (!rec.newSha256 || !fs.existsSync(rec.file)) continue;
      if (F.sha256Hex(F.readBuf(rec.file)) === rec.newSha256) patched++;
    }
    patchedHow = '（按落盘记录核对哈希）';
  } else {
    for (const t of rules.targets) {
      const abs = path.join(appDir, t.file);
      if (!fs.existsSync(abs)) continue;
      if (fs.readFileSync(abs, 'utf8').includes('新建智能体')) patched++;
    }
    patchedHow = '（探针字符串判断）';
  }
  const sameVersion = Boolean(cand && cand.commit === info.commit);
  const pending = cand
    ? Object.entries(cand.entries).filter(([v, e]) => e.safety !== 'skip' && !tr.byText[v]).length
    : null;

  let next;
  if (!cand || !sameVersion) next = 'node src/cli.js scan';
  else if (!patched) next = 'node src/cli.js apply --force（Cursor 完全退出后运行更稳）';
  else if (pending) next = 'tools/run-translate.ps1 补翻新文案，然后 apply';
  else next = '无需操作；Cursor 升级后重新 scan → apply';

  const result = {
    version: info.version,
    commit: info.commit,
    appDir: info.appDir,
    installDir: info.installDir,
    patched,
    sameVersion,
    snapshotVersion: cand ? cand.version : null,
    snapshotCommit: cand ? cand.commit : null,
    translations: Object.keys(tr.byText).length,
    pending,
    next,
  };
  if (arg('json', false)) { log(JSON.stringify(result)); return 0; }

  log(`Cursor        ${info.version}  (commit ${String(info.commit).slice(0, 10)})`);
  log(`安装目录      ${info.installDir}`);
  log(`补丁状态      ${patched ? `已打补丁（${patched} 个文件` + patchedHow + `）` : '未打补丁（英文）'}`);
  log(`扫描快照      ${cand ? `${cand.version} / ${String(cand.commit).slice(0, 10)}${sameVersion ? '（与当前安装一致）' : '（与当前安装不一致，需要重新 scan）'}` : '无（需要 scan）'}`);
  log(`译文库        ${Object.keys(tr.byText).length} 条（按英文原文复用，升级后不浪费）`);
  if (pending !== null) log(`待翻译        ${pending} 条${pending ? '（运行 tools/run-translate.ps1 补翻，或直接 apply 保持英文）' : ''}`);
  log(`下一步        ${next}`);
  return 0;
}

/**
 * 落盘清单丢了也能还原：直接扫描备份目录重建。
 * 备份文件名是 "out__vs__workbench__xxx.js.gz" 这种把路径分隔符换成 __ 的形式。
 */
function reconstructManifest(appDir) {
  const backupRoot = path.join(WORK, 'backups');
  if (!fs.existsSync(backupRoot)) return null;
  const dirs = fs.readdirSync(backupRoot).sort().reverse();
  for (const dirName of dirs) {
    const dir = path.join(backupRoot, dirName);
    if (!fs.statSync(dir).isDirectory()) continue;
    const gzFiles = fs.readdirSync(dir).filter(f => f.endsWith('.gz'));
    if (!gzFiles.length) continue;
    const manifest = { reconstructedAt: new Date().toISOString(), commit: dirName, appDir, files: [], product: null };
    for (const f of gzFiles) {
      const rel = f.replace(/\.gz$/, '').replace(/__/g, path.sep);
      const rec = { file: path.join(appDir, rel), relName: rel, backupPath: path.join(dir, f) };
      if (rel === 'product.json') manifest.product = rec;
      else manifest.files.push(rec);
    }
    return manifest;
  }
  return null;
}

function cmdRestore() {
  let manifest = readJson(path.join(WORK, 'applied.json'), null);
  if (!manifest) {
    const { appDir } = resolveAppDir(PROJECT_ROOT, arg('app-dir', null) || null);
    manifest = reconstructManifest(appDir);
    if (manifest) {
      log(`未找到 work/applied.json，已从备份目录重建清单（commit ${manifest.commit}，${manifest.files.length} 个文件 + product.json）`);
    }
  }
  if (!manifest) throw new Error('没有 work/applied.json，也找不到 work/backups/ 下的备份，无法还原');
  if (P.isCursorRunning() && !arg('force', false)) {
    log('Cursor 正在运行。请完全退出 Cursor 后重试（或 --force）。');
    return 2;
  }
  for (const rec of manifest.files) {
    F.restoreFromBackup(rec);
    log(`已还原 ${rec.file}`);
  }
  if (manifest.product) {
    F.restoreFromBackup(manifest.product);
    log('已还原 product.json');
  }
  const appliedPath = path.join(WORK, 'applied.json');
  if (fs.existsSync(appliedPath)) {
    fs.renameSync(appliedPath, path.join(WORK, 'applied.restored.json'));
  }
  log('还原完成。重启 Cursor 生效。');
  return 0;
}

// ─────────────────────────────── main ───────────────────────────────
const COMMANDS = { doctor: cmdDoctor, status: cmdStatus, scan: cmdScan, batch: cmdBatch, merge: cmdMerge, verify: cmdVerify, plan: cmdPlan, apply: cmdApply, restore: cmdRestore, audit: cmdAudit };

function main() {
  const cmd = process.argv[2];
  if (!cmd || !COMMANDS[cmd]) {
    log('用法：node src/cli.js <doctor|status|scan|batch|merge|verify|plan|apply|restore|audit>');
    log('  --app-dir=<path>  指定 Cursor 的 resources/app');
    log('  --only=<labels>   scan 只处理某些目标（agent-window,editor-window,automations）');
    log('  --size=120        batch 每批条数');
    log('  --from=<dir>      merge 从这个目录收集 worker 产物');
    log('  --force           apply/restore 在 Cursor 运行时也尝试');
    process.exit(cmd ? 2 : 1);
  }
  try {
    process.exit(COMMANDS[cmd]() || 0);
  } catch (err) {
    console.error('\n错误：' + err.message);
    process.exit(3);
  }
}

main();
