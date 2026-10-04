'use strict';
/**
 * 批量翻译：直接调用 DeepSeek API（JSON 模式），逐批落盘、可续跑。
 *
 * 密钥来源：环境变量 DEEPSEEK_API_KEY（由 tools/run-translate.ps1 在运行时从
 * ~/.codex/deepseek-worker.key.dpapi 用 DPAPI 解密注入，绝不写入文件）。
 *
 * 用法：
 *   node src/translate.js --size=60 --concurrency=5 [--limit=2] [--only=001,002] [--force]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA = path.join(PROJECT_ROOT, 'data');
const WORK = path.join(PROJECT_ROOT, 'work');

function arg(name, def) {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const API_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';

function httpsJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* keep null */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const PLACEHOLDER_RE = /\{\d+\}|\$\([a-zA-Z0-9~-]+\)|%[sd]|\\n|\\u\{[0-9A-Fa-f]{1,6}\}|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}|<[a-z/][^>]{0,40}>/g;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D]/gu;
function placeholders(s) {
  return (s.match(PLACEHOLDER_RE) || []).sort().join('|');
}
function emojiCount(s) {
  const m = s.match(EMOJI_RE);
  return m ? m.length : 0;
}

function buildSystemPrompt(glossary) {
  const terms = Object.entries(glossary.terms).map(([en, zh]) => `${en}=${zh}`).join('；');
  const keep = glossary.keep.join('、');
  return [
    '你是 Cursor 代码编辑器（基于 VS Code）的界面本地化译者，把英文界面文案译成简体中文。',
    '输出要求：只输出一个 JSON 对象，键是输入里的 id，值是译文，不要输出任何解释或 Markdown。',
    '翻译要求：',
    '1. 短、直接、像中文产品界面用语；动词用「保存/取消/重试」这类，不要「请点击…」的长句。',
    '2. 保留占位符原样：{0}、{1}、$(icon)、%s、<tag>。不要翻译 URL、文件路径、命令行、代码标识符。',
    '3. 术语必须统一：' + terms,
    '4. 这些词保持英文不译：' + keep,
    '5. 输入里的 prop 表示它在界面上的位置（label=按钮或菜单文字，description=说明文字，placeholder=输入框提示，title=标题，tooltip=悬浮提示，message=提示消息）；ctx 是源码上下文，用来消歧，不要翻译。',
    '6. 如果一条文案本身就是代码标识符或错误码（例如 internal_error、ENOENT），原样返回。',
    '7. 首字母大小写、结尾省略号、问号等语气要保持一致。',
  ].join('\n');
}

function loadBatches(size) {
  const cand = readJson(path.join(DATA, 'candidates.json'), null);
  if (!cand) throw new Error('先运行 node src/cli.js scan');
  const priority = ['agent-window', 'editor-window', 'automations'];
  const items = Object.entries(cand.entries)
    .filter(([, e]) => e.safety !== 'skip')
    .map(([value, e]) => {
      const labels = Object.keys(e.files);
      const rank = Math.min(...labels.map(l => (priority.indexOf(l) === -1 ? 99 : priority.indexOf(l))));
      return { value, e, rank };
    })
    .sort((a, b) => a.rank - b.rank || b.e.ui - a.e.ui || a.value.localeCompare(b.value));

  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    const id = String(batches.length + 1).padStart(3, '0');
    const rows = items.slice(i, i + size).map(({ value, e }, n) => {
      const short = !/\s/.test(value) || value.split(/\s+/).length <= 3;
      const ctx = short && e.sample ? `${e.sample.before.slice(-45)} ⟦HERE⟧ ${e.sample.after.slice(0, 45)}` : undefined;
      const row = { id: `${id}-${String(n + 1).padStart(3, '0')}`, text: value, prop: e.sample ? e.sample.prop : Object.keys(e.props)[0] || '' };
      if (ctx) row.ctx = ctx;
      return row;
    });
    batches.push({ id, rows });
  }
  return { cand, batches };
}

async function translateBatch(batch, systemPrompt, opts) {
  const missing = [];
  const out = {};
  const rows = batch.rows;
  const ask = async (subset, attempt) => {
    const user = subset.map(r => JSON.stringify(r)).join('\n');
    const payload = {
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `把下面每一条翻译成简体中文，输出 JSON 对象（id → 译文）：\n${user}` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: opts.maxTokens,
    };
    const res = await httpsJson(`${API_BASE}/chat/completions`, payload, opts.timeoutMs);
    if (res.status !== 200) {
      const msg = res.json && res.json.error ? res.json.error.message : res.text.slice(0, 300);
      const err = new Error(`HTTP ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    let parsed;
    try { parsed = JSON.parse(res.json.choices[0].message.content); }
    catch (e) { throw new Error(`返回不是合法 JSON（attempt ${attempt}）：${String(res.json.choices[0].message.content).slice(0, 200)}`); }
    return { parsed, usage: res.json.usage, finish: res.json.choices[0].finish_reason };
  };

  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let pending = rows;
  for (let attempt = 1; attempt <= 3 && pending.length; attempt++) {
    let result;
    try {
      result = await ask(pending, attempt);
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(2000 * attempt);
      continue;
    }
    usage.prompt_tokens += result.usage.prompt_tokens || 0;
    usage.completion_tokens += result.usage.completion_tokens || 0;
    usage.total_tokens += result.usage.total_tokens || 0;
    const still = [];
    for (const row of pending) {
      const t = result.parsed[row.id];
      if (typeof t === 'string' && t.trim()) out[row.id] = t.trim();
      else still.push(row);
    }
    pending = still;
    if (pending.length && attempt < 3) await sleep(1000);
  }
  for (const row of pending) missing.push(row.id);
  return { out, missing, usage };
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error('缺少 DEEPSEEK_API_KEY。请用 tools/run-translate.ps1 运行（它会用 DPAPI 解密你的密钥）。');
  }
  const size = Number(arg('size', 60));
  const concurrency = Number(arg('concurrency', 5));
  const limit = arg('limit', null);
  const only = arg('only', null);
  const force = Boolean(arg('force', false));
  const { cand, batches } = loadBatches(size);
  const glossary = readJson(path.join(PROJECT_ROOT, 'config', 'glossary.json'), {});

  let todo = batches;
  if (only) {
    const want = String(only).split(',');
    todo = todo.filter(b => want.includes(b.id));
  }
  if (limit) todo = todo.slice(0, Number(limit));

  const trPath = path.join(DATA, 'translations.zh.json');
  const tr = readJson(trPath, { generatedAt: null, byId: {}, byText: {}, usage: { total_tokens: 0, calls: 0 } });
  tr.byId = tr.byId || {}; tr.byText = tr.byText || {};
  tr.usage = tr.usage || { total_tokens: 0, calls: 0 };

  // 已有译文的条目直接跳过（按原文匹配，重跑不重复花钱）
  for (const b of batches) {
    if (force) continue;
    b.rows = b.rows.filter(r => !tr.byText[r.text]);
  }
  const isDone = batch => batch.rows.length === 0;
  const pendingBatches = todo.filter(b => !isDone(b));
  console.log(`批次总数 ${batches.length}，本次处理 ${todo.length}，其中已译 ${todo.length - pendingBatches.length}，待译 ${pendingBatches.length}`);
  if (!pendingBatches.length) return;

  const systemPrompt = buildSystemPrompt(glossary);
  const failuresPath = path.join(WORK, 'translate-failures.json');
  const failures = readJson(failuresPath, { batches: {} });
  let done = 0, tokens = 0;

  const queue = pendingBatches.slice();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const batch = queue.shift();
      const started = Date.now();
      try {
        const { out, missing, usage } = await translateBatch(batch, systemPrompt, { maxTokens: 8192, timeoutMs: 120000 });
        let accepted = 0;
        for (const row of batch.rows) {
          const target = out[row.id];
          if (!target) continue;
          const phOk = placeholders(row.text) === placeholders(target);
          const emojiOk = emojiCount(row.text) === 0 || emojiCount(target) > 0;
          if (!phOk || !emojiOk) {
            failures.batches[row.id] = { source: row.text, target, reason: phOk ? 'emoji-lost' : 'placeholder-mismatch' };
            continue;
          }
          tr.byId[row.id] = { source: row.text, target };
          tr.byText[row.text] = target;
          accepted++;
        }
        tokens += usage.total_tokens || 0;
        tr.usage.total_tokens += usage.total_tokens || 0;
        tr.usage.calls = (tr.usage.calls || 0) + 1;
        tr.generatedAt = new Date().toISOString();
        writeJson(trPath, tr);
        writeJson(failuresPath, failures);
        done++;
        console.log(`✓ 批次 ${batch.id}：接受 ${accepted}/${batch.rows.length}，缺失 ${missing.length}，${((Date.now() - started) / 1000).toFixed(1)}s，累计 ${done}/${pendingBatches.length}，token ${tokens}`);
      } catch (err) {
        failures.batches[batch.id] = { reason: String(err.message).slice(0, 300) };
        writeJson(failuresPath, failures);
        console.error(`✗ 批次 ${batch.id} 失败：${err.message}`);
        if (err.status === 401 || err.status === 403) throw err;
      }
    }
  });
  await Promise.all(workers);

  const total = Object.keys(tr.byText).length;
  const wanted = Object.values(cand.entries).filter(e => e.safety !== 'skip').length;
  console.log('');
  console.log(`翻译完成：累计 ${total}/${wanted} 条，本次消耗 ${tokens} token（累计 ${tr.usage.total_tokens}）`);
  const failCount = Object.keys(failures.batches).length;
  if (failCount) console.log(`有 ${failCount} 条/批需要复查：work/translate-failures.json`);
}

main().catch(err => {
  console.error('错误：' + err.message);
  process.exit(1);
});
