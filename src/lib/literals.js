'use strict';
/**
 * 字面量扫描与安全分类 —— 整个工具的安全边界都在这里。
 *
 * 思路：
 * 1) 用正则扫出文件里所有单/双引号与模板字面量。
 * 2) 看每个字面量**前面 90 个字符**判断它处在什么上下文：
 *      ui      —— label: / title: / description: 这类 UI 字段的值
 *      id      —— id: / key: / type: / command: 这类功能性字段的值
 *      key     —— 对象键、数组元素（[...] 或 {...} 后面）
 *      compare —— === / case / switch 里
 *      method  —— .includes(...) / .test(...) / .replace(...) 等
 *      dom     —— querySelector / classList / dataset 等
 *      code    —— return / typeof / new 等
 *      other   —— 其余
 * 3) 按统计结果给出安全等级：
 *      auto    —— 出现位置全是 UI，且是自然语言（含空格）。可以全局替换。
 *      context —— 只在 ui 上下文的那几处替换（用于单词标签，如 "Agent"）。
 *      skip    —— 从不出现于 UI，或长得像功能性标识。
 */
const fs = require('fs');

const LITERAL_RE = /"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'/g;

function decodeLoose(raw) {
  const body = raw.slice(1, -1);
  return body
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; }
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function hasCJK(s) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(s);
}

/** 看起来像代码/标识/路径/快捷键，而不是给人看的文案 */
function looksLikeCode(v) {
  if (/^[\w$./\\:@#%&?=~+*<>|^!,;()\[\]{}-]+$/.test(v) && !/\s/.test(v)) return true; // 无空格的单 token
  if (/:\/\//.test(v)) return true;
  if (/^[./\\]/.test(v)) return true;
  if (/^[\w-]+(\.[\w-]+)+$/.test(v)) return true;                     // a.b.c / foo-bar.baz
  if (/^[0-9a-fA-F]{3,8}$/.test(v)) return true;                      // 颜色/哈希
  if (/^(Ctrl|Cmd|Alt|Shift|Meta|Option|Super)([+-](Ctrl|Cmd|Alt|Shift|Meta|Option|Super|[A-Za-z0-9]|F\d{1,2}))+$/.test(v)) return true;
  if (/^(https?|file|vscode|cursor|mailto|data):/.test(v)) return true;
  if (/^[a-z][a-zA-Z0-9]*$/.test(v)) return true;                     // camelCase 单词
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(v)) return true;                // kebab-case
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(v)) return true;                // snake_case
  if (/^[A-Z0-9_]+$/.test(v)) return true;                            // CONSTANT
  if (/[{}<>$]/.test(v)) return true;                                 // 插值/模板残留
  if (/^[\d\s.,:;/\\-]+$/.test(v)) return true;                       // 纯数字标点
  if (!/[A-Za-z]/.test(v)) return true;                               // 没有拉丁字母
  return false;
}

const KIND_UI = 'ui';
const KIND_ID = 'id';
const KIND_KEY = 'key';
const KIND_COMPARE = 'compare';
const KIND_METHOD = 'method';
const KIND_DOM = 'dom';
const KIND_CODE = 'code';
const KIND_OTHER = 'other';

function buildClassifiers(rules) {
  const ui = rules.uiProps.join('|').replace(/[-]/g, '\\-');
  const id = rules.idProps.join('|');
  const uiRe = new RegExp('(?:^|[^\\w$.-])(' + ui + ')\\s*:\\s*$');
  const idRe = new RegExp('(?:^|[^\\w$.-])(' + id + ')\\s*:\\s*$');
  return (prefix) => {
    let m = prefix.match(uiRe);
    if (m) return { kind: KIND_UI, prop: m[1] };
    m = prefix.match(idRe);
    if (m) return { kind: KIND_ID, prop: m[1] };
    if (/[{,[]\s*$/.test(prefix)) return { kind: KIND_KEY };
    if (/(?:===|!==|==|!=|<=|>=|<|>)\s*$/.test(prefix)) return { kind: KIND_COMPARE };
    if (/\b(?:case|switch)\b[^;]{0,40}$/.test(prefix)) return { kind: KIND_COMPARE };
    if (/\.\s*(?:includes|startsWith|endsWith|indexOf|lastIndexOf|match|matchAll|test|split|replace|replaceAll|localeCompare|trim|toLowerCase|toUpperCase|padStart|padEnd|charAt|concat)\s*\(\s*[^)]*$/.test(prefix)) return { kind: KIND_METHOD };
    if (/(?:getElementById|querySelector|querySelectorAll|createElement|classList|setAttribute|getAttribute|dataset|localStorage|sessionStorage|appendChild)\b[^;]{0,40}$/.test(prefix)) return { kind: KIND_DOM };
    if (/\b(?:return|typeof|instanceof|new|delete|throw|in|of)\s*$/.test(prefix)) return { kind: KIND_CODE };
    if (/[A-Za-z0-9_$)\]]\s*$/.test(prefix) && /\(\s*$/.test(prefix)) return { kind: KIND_METHOD };
    return { kind: KIND_OTHER };
  };
}

function cleanSnippet(s) {
  return s.replace(/\s+/g, ' ').trim().slice(0, 100);
}

/**
 * 扫一个文件。
 * @returns {Map<string, entry>}  key = 解码后的文案
 */
function scanFile(absPath, label, rules, opts) {
  const options = opts || {};
  const src = fs.readFileSync(absPath, 'utf8');
  const lookback = rules.limits.contextLookback;
  const minLen = rules.limits.minLength;
  const maxLen = rules.limits.maxLength;
  const classify = buildClassifiers(rules);
  const entries = new Map();
  const nonAscii = new Map();   // 原文自带的非 ASCII 字面量（审计用）

  LITERAL_RE.lastIndex = 0;
  let m;
  let seen = 0;

  // 1) 先收集所有字面量匹配
  const matches = [];
  while ((m = LITERAL_RE.exec(src)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  LITERAL_RE.lastIndex = 0;

  // 2) 丢掉嵌套在另一个字面量内部的匹配。
  //    单引号字符串里出现的 "双引号片段" 会被正则当成独立字面量，这类内层假匹配
  //    既不该被翻译，也会和外壳的替换打架，所以只保留最外层。
  const outer = [];
  let lastEnd = -1;
  for (const mt of matches) {
    if (mt.start < lastEnd) continue;
    outer.push(mt);
    lastEnd = mt.end;
  }

  for (const mt of outer) {
    const raw = mt.raw;
    const bodyLen = raw.length - 2;
    if (bodyLen < minLen || bodyLen > maxLen) continue;
    const body = raw.slice(1, -1);
    if (body.includes('${') || body.includes('\\n') || body.includes('\\t')) continue;
    const value = decodeLoose(raw);
    if (!value) continue;
    if (hasCJK(value) && !options.includeCJK) {
      // 原文自带的中文（Cursor 自己的多语言文案）：记录清单供审计使用，不参与翻译
      if (options.collectNonAscii) nonAscii.set(value, (nonAscii.get(value) || 0) + 1);
      continue;
    }
    if (/[\r\n]/.test(value)) continue;
    seen++;

    const start = mt.start;
    const prefix = src.slice(Math.max(0, start - lookback), start);
    const cls = classify(prefix);

    let e = entries.get(value);
    if (!e) {
      e = {
        value,
        ui: 0, risky: 0, other: 0,
        props: {}, riskyKinds: {},
        raw: {},
        sample: null,
      };
      entries.set(value, e);
    }
    let rec = e.raw[raw];
    if (!rec) { rec = { total: 0, ui: [], all: [], risky: 0, other: 0 }; e.raw[raw] = rec; }
    rec.total++;
    rec.all.push(start);

    if (cls.kind === KIND_UI) {
      e.ui++;
      rec.ui.push(start);
      e.props[cls.prop] = (e.props[cls.prop] || 0) + 1;
      if (!e.sample) {
        e.sample = {
          file: label,
          prop: cls.prop,
          before: cleanSnippet(src.slice(Math.max(0, start - 70), start)),
          after: cleanSnippet(src.slice(start + raw.length, start + raw.length + 70)),
        };
      }
    } else if (cls.kind === KIND_OTHER) {
      e.other++;
      rec.other++;
    } else {
      e.risky++;
      rec.risky++;
      e.riskyKinds[cls.kind] = (e.riskyKinds[cls.kind] || 0) + 1;
    }
  }
  return { src, entries, seen, nonAscii };
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'in', 'on', 'at', 'to', 'of', 'for', 'with', 'and', 'or', 'if', 'is', 'are',
  'was', 'were', 'be', 'by', 'as', 'it', 'its', 'this', 'that', 'these', 'those', 'from', 'via',
  'not', 'no', 'yes', 'you', 'your', 'we', 'our', 'i', 'me', 'my', 'he', 'she', 'they', 'them',
]);

/** 汇总多个文件的扫描结果，给出安全等级 */
function classify(entry) {
  const v = entry.value;
  const hasSpace = /\s/.test(v);
  const natural = hasSpace && !looksLikeCode(v);
  let safety;
  if (entry.ui === 0) safety = 'skip';
  else if (entry.risky === 0 && natural) safety = 'auto';
  else if (looksLikeCode(v) && entry.ui === 0) safety = 'skip';
  else safety = 'context';
  if (/^(Ctrl|Cmd|Alt|Shift|Meta|Option|Super)[+-]/.test(v)) safety = 'skip';
  if (/^[\w.+-]+@[\w.-]+$/.test(v)) safety = 'skip';
  // 句子碎片与错误码：单行小写标识符（internal_error、agent）、单个虚词
  if (!hasSpace && /^[a-z][a-z0-9_]*$/.test(v)) safety = 'skip';
  if (!hasSpace && STOPWORDS.has(v.toLowerCase())) safety = 'skip';
  if (/^[\d\s.,:;/\\%+\-·•–—]+$/.test(v)) safety = 'skip';
  // CSS 类名 / 驼峰 / kebab / snake 片段，不该当成界面文案
  if (/^[a-z]+(-[a-zA-Z0-9]+)+$/.test(v)) safety = 'skip';
  if (/^[a-z]+[A-Z][a-zA-Z0-9]*$/.test(v)) safety = 'skip';
  if (/^[a-z0-9]+([-_][a-z0-9]+)+$/.test(v)) safety = 'skip';
  return { safety, natural };
}

module.exports = { scanFile, classify, decodeLoose, looksLikeCode, hasCJK, cleanSnippet };
