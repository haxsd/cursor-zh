# 实现与安全设计

这份文档写给想改这个工具的人：它改哪些文件、怎么判断哪些字符串能替换、有哪些门禁。
只看安装使用请回 [README](../README.md)。

## 覆盖范围

Cursor 自有界面的英文直接写在编译后的 JS 包里，工具只动这三个文件：

| 文件 | 覆盖范围 | 在 `product.json` 校验表 |
| --- | --- | --- |
| `out/vs/workbench/workbench.glass.main.js` | Agent 窗口（glass 模式） | 否 |
| `out/vs/workbench/workbench.desktop.main.js` | 编辑器窗口、Cursor 设置页 | 是 |
| `out/vs/workbench/workbench.anysphere-ui-automations.js` | Automations | 否 |

`product.json` 里被校验的文件改完必须同步校验值，否则 Cursor 可能判定安装被篡改——`apply` 会自动同步。

## 怎么判断哪些字符串能替换

**先扫描再替换**，不靠全局搜索替换。扫描器（`src/lib/literals.js`）对每个字面量看它**前面 90 个字符**
的上下文，分成几类：

| 上下文 | 含义 |
| --- | --- |
| `ui` | `label:` / `title:` / `description:` 这类 UI 字段的值 |
| `id` | `id:` / `key:` / `type:` / `command:` 这类功能性字段的值 |
| `key` | 对象键、数组元素 |
| `compare` | `===` / `case` / `switch` 里 |
| `method` | `.includes()` / `.test()` / `.replace()` 等 |
| `dom` | `querySelector` / `classList` / `dataset` 等 |
| `code` | `return` / `typeof` / `new` 等 |

由此给出安全等级：

- **auto** —— 出现位置全是 UI，且是自然语言（含空格）。可以全局替换。
- **context** —— 只在 UI 上下文的那几处替换（用于同时出现在别处的单词标签，如 `Agent`）。
- **skip** —— 从不出现于 UI，或长得很像功能性标识（camelCase、kebab-case、URL、快捷键、常量…）。

### UI 属性白名单与后缀

`config/rules.json` 的 `uiProps` 是**精确匹配**的白名单（`label`/`title`/`description`/…），
`uiPropSuffixes` 是**后缀匹配**：带前缀的属性名（`autoUsageBarLabel`、`settingsButtonTitle`、
`apiDescription`）也按 UI 处理。加上后缀匹配后候选从 4,400 涨到 4,694——账号页、用量面板那些
文案此前整批漏网，就是因为属性名带前缀。

`Text` 这类后缀**故意不收**：`sortText`/`suggestSortText`（补全排序）、`searchText`（过滤）、
`newText`/`oldText`/`mergedText`（差异内容）都是功能值，翻译会改变行为。试算时还抓到
`oklch(...)` 颜色值会被误判成可翻译文案（含空格，`looksLikeCode` 认不出来）。

个别漏网的不该翻条目（图标语法 `$(lightbulb)`、点号标识符 `notebook.globalToolbarShowLabel`、
日志消息）用 `config/overrides.json` 的**原样映射**挡掉——`apply` 里有一条
`译文 === 原文则不替换`，所以 `"X": "X"` 等价于"永不替换"，比加规则简单。

### 其他扫描处理

- **丢掉嵌套假字面量**：`'<span title="Cloud Agent">'` 这样的字符串里，双引号片段会被引号配对
  误判成独立字面量；扫描器只保留最外层匹配，避免重复替换与半截翻译。
- **不改写转义写法**：译文与原文相同（或仅转义写法不同）的条目不替换，所以 `"\u2192"`、`"\u2026"`
  原样保留，不会被改写成字面的 `→`、`…`；emoji 用真实字符写入，不残留 `\u{...}`。

## 替换与落盘门禁

- **显式替换区间**：每条替换都对应扫描时记录的确切字节区间，不用全局字符串搜索，不会误伤同名的其他出现。
- **落盘前三道校验**：替换后先跑 `node --check` 编译校验；核对文件大小与版本门禁；写入后再审计字面量清单。
- **三方口径一致**：`plan`（要替换多少处）、`apply`（实际替换多少处）、`audit`（文件里字面量清单的
  变化量）用同一套区间模型计算，三者数字必须相等；不等说明模型与实现脱节。
- **版本门禁**：`apply` 会核对 `candidates.json` 的 commit 与当前安装是否一致、每个文件大小是否与扫描时
  一致，不一致就拒绝落盘（宁可不动，也不把旧坐标套到新文件上写坏）。`restore` 同样核对备份的 commit，
  不一致就拒绝——上一版备份是旧文件，拿它还原会把 Cursor 变成新旧混合状态（确实要冒险才加 `--allow-stale`）。
- **scan 的两道门禁**：在已汉化的文件上扫描会被拒绝（否则会把中文当文案、覆盖掉好的英文快照）；
  `--only` 只写 `data/candidates.partial.json`，不污染完整快照。
- **全程可回退**：原始文件 gzip 备份在 `work/backups/<commit>/`，`restore` 一条命令还原（含
  `product.json` 校验值）；即使 `work/applied.json` 丢了，也会从备份目录重建清单。
- 译文与词表都是本项目自建，不联网（只有翻译阶段调用 DeepSeek API）。

## 最近一次落盘核对（Cursor 3.24.18，2026-10-14）

| 项目 | 数量 |
| --- | --- |
| 扫描到的字面量（三个文件合计） | 872,071 条，去重 161,354 条 |
| 判定为界面文案 | 4,695 条（auto 3,551 / context 1,144） |
| 实际替换 | 9,902 处（plan / apply / 审计三方口径一致：6,296 / 3,015 / 591） |
| 译文库 | 4,813 条（DeepSeek 批量翻译 + 人工修正表） |
| 落盘审计 | 三个文件全部一致 ✓（逐字面量核对，非抽样） |
| `product.json` 校验值 | 已同步，`doctor` 显示匹配 ✓ |

示例：`New Agent → 新建智能体`、`Cloud Agents → 云端智能体`、`Plan Mode → 计划模式`、
`Fork Chat → 分叉对话`、`Cloud → 云端`、`Learn More → 了解更多`。

## 常用命令

```powershell
node src/cli.js doctor    # 定位安装目录、验证校验算法与语法校验器
node src/cli.js scan      # 抽取候选文案 + 安全分类 + 记录替换区间 → data/candidates.json
node src/cli.js batch     # 生成翻译批次 → work/batches（供 translate.js 使用）
node src/cli.js verify    # 校验译文：占位符/转义/emoji/术语 → reports/verify-report.md
node src/cli.js plan      # dry-run：每个文件将要替换多少处 → reports/plan.md
node src/cli.js apply     # 备份 → 替换 → 更新校验值 → 落盘审计
node src/cli.js audit     # 事后核对：被替换后的字面量清单必须与计划一致
node src/cli.js restore   # 还原英文（只允许同版本备份）
```

补翻文案（Windows）：

```powershell
powershell -ExecutionPolicy Bypass -File tools\run-translate.ps1 --size=60 --concurrency=5
```

密钥从 `~/.codex/deepseek-worker.key.dpapi` 用 DPAPI 解密后注入进程环境变量，不落盘。
其他平台直接设 `DEEPSEEK_API_KEY` 环境变量后运行 `node src/translate.js`。

## 目录

```
config/glossary.json   术语表（翻译时注入 prompt，verify 时做一致性检查）
config/overrides.json  人工修正表（优先于 API 译文；原样映射＝禁用该条替换）
config/rules.json      抽取与替换规则（UI 字段白名单与后缀、跳过规则、长度限制）
src/cli.js             全部子命令（doctor/status/scan/batch/merge/verify/plan/apply/restore/audit）
src/translate.js       批量翻译（DeepSeek JSON 模式，按原文续跑，不重复花钱）
src/lib/literals.js    字面量扫描与安全分类（安全边界都在这里）
src/lib/paths.js       跨平台定位 Cursor 安装目录、读取 product.json
src/lib/files.js       哈希、备份、原子写入
tools/bootstrap.js     一条命令上手（检测 → 扫描 → 补翻 → 打补丁 → 审计）
tools/run-translate.ps1 Windows：DPAPI 解密密钥并注入环境后运行翻译
data/translations.zh.json  译文（进版本库，跨机器复用）
work/                  批次、备份、本机配置（不进版本库）
reports/               抽取/校验/审计报告（不进版本库）
```
