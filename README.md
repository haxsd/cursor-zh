# cursor-zh-hans

把 Cursor 桌面端**自有界面**（Agent 窗口 / Cursor 设置页 / 账号页 / Automations）翻成简体中文的本地工具。

当前已应用到本机：**Cursor 3.23.12**（commit `2d29876d56`，安装于 `D:\cursor\cursor`），
共替换 **9,848 处**，覆盖 3 个程序文件。

## 为什么需要这个

Cursor 官方支持 `Configure Display Language` + 语言包，但语言包只能翻译从 VS Code 继承的外壳
（菜单、命令面板、标准设置项）。它依赖 `out/nls.messages.json` 里的键，而 Cursor 自有界面的英文
**直接写在编译后的 JS 里**，语言包永远碰不到：

| 文件 | 大小 | 覆盖范围 | 在校验表 |
| --- | --- | --- | --- |
| `out/vs/workbench/workbench.glass.main.js` | 44.3 MB | Agent 窗口（glass 模式） | 否 |
| `out/vs/workbench/workbench.desktop.main.js` | 37.4 MB | 编辑器窗口、Cursor 设置页 | 是 |
| `out/vs/workbench/workbench.anysphere-ui-automations.js` | 8.4 MB | Automations | 否 |

## 当前成果

| 项目 | 数量 |
| --- | --- |
| 扫描到的字面量（三个文件合计） | 858,873 条，去重 158,167 条 |
| 判定为界面文案 | 4,429 条（auto 3,333 / context 1,096） |
| 实际替换 | 9,848 处 |
| 完成翻译 | 4,435 条（DeepSeek 批量翻译 + 人工修正表） |
| 落盘审计 | 三个文件全部一致 ✓ |
| product.json 校验值 | 已同步，`doctor` 显示匹配 ✓ |

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
node src/cli.js restore   # 一键还原英文
```

翻译（需要本机 `~/.codex/deepseek-worker.key.dpapi`，密钥只在进程环境里解密，不落盘）：

```powershell
powershell -ExecutionPolicy Bypass -File tools\run-translate.ps1 --size=60 --concurrency=5
```

## Cursor 升级后怎么办

升级会覆盖这三个文件（英文界面自动回来，不会坏）。要重新汉化：

```powershell
node src/cli.js scan      # 对新版本重新抽取（必须，替换坐标按当前文件记录）
powershell -ExecutionPolicy Bypass -File tools\run-translate.ps1   # 只翻新增文案，已有译文按原文复用
node src/cli.js apply --force
```

`apply` 有两条门禁：candidates.json 的 commit 必须与当前安装一致；每个文件大小必须与扫描时一致。
不一致就拒绝落盘（防止把旧坐标套到新文件上）。所以**必须先 scan 再 apply**。

也可以完全退出 Cursor 后双击 `work\apply.cmd`（重新打中文）或 `work\restore.cmd`（还原英文）。
Cursor 正在运行时也能热替换，但需要重启 Cursor 才生效。

## 安全设计

- **只在 UI 字段上下文替换**：`label`/`title`/`description`/`placeholder`/`children` 等；
  同时出现在对象键、`===` 比较、`id:`/`key:`/`type:` 等位置的字符串只替换其 UI 出现处（context 级），
  其余位置一律不动。
- **丢掉嵌套假字面量**：`'<span title="Cloud Agent">'` 这类字符串里的双引号片段会被引号配对
  误判成独立字面量，扫描器只保留最外层匹配，避免重复替换与半截翻译。
- **显式替换区间**：每条替换都对应扫描时记录的确切字节区间，不用全局字符串搜索，
  不会误伤同名的其他出现。
- **落盘前三道校验**：替换后 `node --check` 编译校验；文件大小/版本门禁；写入后审计字面量清单。
- **全程可回退**：原始文件 gzip 备份在 `work/backups/<commit>/`，`restore` 一条命令还原（含 product.json 校验值）。
- 译文与词表都是本项目自建，不联网（只有翻译阶段调用 DeepSeek API）。

## 已知边界

- **命令面板按英文搜命令会搜不到**：这是汉化方案的固有代价。
- **仍有英文残留**：`verify` 报告里有 200 条与原文相同的条目，绝大多数是专有名词（`Cursor`、`GitHub`、
  `Dockerfile`、模型代号 `Atlas`/`Aurora`）、URL、代码标识符、LaTeX 命令，属于有意保留。
- **功能性位置的字符串保留英文**（例如同时用作存储键或协议值的 `Cancel`），这类约有数百处。
- **走 NLS 的内置文案**（`out/nls.messages.json` 里 Cursor 自己的 287 条，如部分快捷入口）需要
  单独做语言包扩展才能覆盖，目前未做。官方 VS Code 中文语言包只能覆盖继承自 VS Code 的外壳部分。
- 截图、Webview 内嵌页面、Cursor 服务端返回的文案不受影响。

## 与社区方案的关系

思路参考了 [polang233/cursor-language-pack](https://github.com/polang233/cursor-language-pack) 与
[rongwei-lab/cursor-chinese](https://github.com/rongwei-lab/cursor-chinese)（均为 MIT）：
都靠改写这几个编译后的 JS 包并同步 `product.json` 校验值。本项目的差异是
**先扫描出带区间的候选集再翻译**，替换坐标显式化，并带落盘审计门禁；译文与词表为自建。

## 目录

```
config/glossary.json   术语表（翻译时注入 prompt，verify 时做一致性检查）
config/overrides.json  人工修正表（优先于 API 译文）
config/rules.json      抽取与替换规则（UI 字段白名单、跳过规则、长度限制）
src/cli.js             全部子命令
src/translate.js       批量翻译（DeepSeek JSON 模式，可按原文续跑）
src/lib/literals.js    字面量扫描与安全分类（安全边界都在这里）
src/lib/paths.js       定位 Cursor 安装目录、读取 product.json
src/lib/files.js       哈希、备份、原子写入
tools/run-translate.ps1 DPAPI 解密并注入密钥后运行翻译
data/translations.zh.json  译文（进版本库）
work/                  批次、备份、运行配置（不进版本库）
reports/               抽取/校验/审计报告（不进版本库）
```
