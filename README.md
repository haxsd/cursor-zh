# cursor-zh

把 Cursor 桌面端**自有界面**（Agent 窗口 / Cursor 设置页 / 账号页 / Automations）翻成简体中文的本地工具。

当前已应用到本机：**Cursor 3.23.12**（commit `2d29876d56`，安装于 `D:\cursor\cursor`），
共替换 **9,307 处**，覆盖 3 个程序文件。

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
| 实际替换 | 9,307 处（plan / apply / 审计三方口径完全一致） |
| 完成翻译 | 4,435 条（DeepSeek 批量翻译 + 人工修正表） |
| 落盘审计 | 三个文件全部一致 ✓（逐字面量核对，非抽样） |
| product.json 校验值 | 已同步，`doctor` 显示匹配 ✓ |

示例：`New Agent → 新建智能体`、`Cloud Agents → 云端智能体`、`Plan Mode → 计划模式`、
`Fork Chat → 分叉对话`、`Cloud → 云端`、`Learn More → 了解更多`。

## 在另一台电脑上装（Windows / macOS）

前提：那台机器装了 **Node.js ≥ 16**（`node -v` 能跑就行；Windows 可用 `winget install OpenJS.NodeJS.LTS`）。

```bash
git clone https://github.com/haxsd/cursor-zh.git
cd cursor-zh
node tools/bootstrap.js --check    # 先看：装在哪、什么版本、补丁在不在
node tools/bootstrap.js            # 一键：检测 → 扫描 → 打补丁 → 审计
```

- 译文库（4,437 条）随仓库一起来，所以**另一台机器不需要任何 API 密钥**；
  只有当那边的 Cursor 版本更新、出现仓库里没有的新文案时才需要翻译（`--with-ai` 或跳过保持英文）。
- 目标机器上必须有这台机器同版本或相近版本的 Cursor；版本不同也能用，`bootstrap` 会现场扫描该机器自己的文件。
- 补丁打完重启 Cursor 生效；要回退：`node src/cli.js restore --force`。

**Windows**：无额外步骤。装到 `D:\cursor\cursor`、`%LOCALAPPDATA%\Programs\cursor`、
`C:\Program Files\Cursor` 都能自动找到。

**macOS**：`apply` 会自动做两件必须做的事——`xattr -cr` 清隔离属性、`codesign --force --deep --sign -`
重做 ad-hoc 签名。因为改动了 `Cursor.app` 里的文件，签名失效会导致系统拒绝启动（提示"已损坏"或
`zsh: killed`），这一步不能省。如果 Cursor 装在 `/Applications` 且当前用户没有写权限，
先把 Cursor 完全退出，再用 `sudo node tools/bootstrap.js`；或把 Cursor.app 放到 `~/Applications` 下。

**Linux**：`/opt/Cursor`、`/usr/share/cursor`、`~/.local/share/cursor` 等常见路径都能找到，无额外步骤。

## 一条命令上手

```bash
node tools/bootstrap.js --check     # 只看：装在哪、什么版本、补丁在不在、还差多少译文
node tools/bootstrap.js             # 检测 → 扫描 → 打补丁 → 审计（用仓库里的 4,437 条译文）
node tools/bootstrap.js --with-ai   # 顺带调用 DeepSeek 补翻新文案（需 DEEPSEEK_API_KEY）
node tools/bootstrap.js --force     # 已打过补丁也重跑一遍
```

译文库 `data/translations.zh.json` 按**英文原文**索引，所以换机器、换 Cursor 小版本都能复用，
只有新增文案需要重新翻译。`work/`（本机路径、备份、批次）与 `data/candidates.json`（按当前版本扫描
出来的替换坐标）都是机器/版本相关的，不进版本库，由 `bootstrap` 现场生成。

定位不到安装目录时用 `node src/cli.js doctor --app-dir="<Cursor>/resources/app"` 显式指定。

`tools/run-translate.ps1` 是 Windows 专用（从 Codex 的 DPAPI 文件里解密密钥）；
其他平台直接设 `DEEPSEEK_API_KEY` 环境变量后运行 `node src/translate.js`。

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

## Cursor 升级后：补丁会失效，但不会坏，重打很快

**会不会失效**：会。Cursor 升级会覆盖那三个文件，中文自动变回英文——不会崩溃、不会报"安装已损坏"，
因为被覆盖的是整个文件（连同我们的改动），`product.json` 也由升级程序重写。

**已有的译文会不会白费**：不会。译文按英文原文索引，升级后能命中的部分直接复用。
实测数据：一次重新扫描后，4,429 条里只有 3 条需要新翻译。

**升级后重打**（约 1–2 分钟，其中扫描 5 秒、替换 10 秒，慢的部分只有翻译新增文案）：

```bash
node src/cli.js scan      # 必须：替换坐标按当前版本的文件重新记录
node tools/bootstrap.js   # 或手动：run-translate → apply → audit
node src/cli.js restore --force   # 任何可疑情况都能一键回到英文
```

**为什么会失效**：补丁记录的是"在某个字节区间把这段英文换成中文"。升级后 Cursor 会重新打包这些文件，
字节位置全变，所以旧的替换坐标必须作废。工具对此有硬门禁：`apply` 会核对
`candidates.json` 的 commit 与当前安装是否一致、每个文件大小是否与扫描时一致，不一致就拒绝落盘
（宁可不动，也不会把旧坐标套到新文件上写坏）。

**升级期间要注意**：Cursor 自动更新时如果正在运行，会先提示重启。建议装好中文后不去动它；
真要升级，升级完按上面三步重打即可。

## 分享给别人 / 免责

- 这是**非官方**工具，与 Anysphere（Cursor）、Microsoft 无关；它修改的是本机 Cursor 安装目录里的
  程序文件，属于社区同类做法（参见 polang233/cursor-language-pack、rongwei-lab/cursor-chinese）。
- 风险与边界：只在 UI 字段上下文替换、落盘前语法校验、写入后审计、全程可回退；但 Cursor 大版本
  更新后新增界面会先显示英文，极端情况下个别功能文案可能与实际行为不符。
- 分享时**不要**把 `work/` 目录带上（里面有本机路径和安装目录备份）；`data/translations.zh.json`
  才是值得共享的资产。
- 协议：MIT。工作台基线译文思路参考了 microsoft/vscode-loc 与上述社区项目。


## 安全设计

- **只在 UI 字段上下文替换**：`label`/`title`/`description`/`placeholder`/`children` 等；
  同时出现在对象键、`===` 比较、`id:`/`key:`/`type:` 等位置的字符串只替换其 UI 出现处（context 级），
  其余位置一律不动。
- **丢掉嵌套假字面量**：`'<span title="Cloud Agent">'` 这类字符串里的双引号片段会被引号配对
  误判成独立字面量，扫描器只保留最外层匹配，避免重复替换与半截翻译。
- **显式替换区间**：每条替换都对应扫描时记录的确切字节区间，不用全局字符串搜索，
  不会误伤同名的其他出现。
- **落盘前三道校验**：替换后 `node --check` 编译校验；文件大小/版本门禁；写入后审计字面量清单。
- **三方口径完全一致**：`plan`（要替换多少处）、`apply`（实际替换多少处）、`audit`（文件里字面量
  清单的变化量）用同一套区间模型计算，三者数字必须相等；数字不相等就说明模型与实现脱节。
  当前为 5,911 / 2,821 / 575 = **9,307 处**。
- **不改写转义写法**：译文与原文相同（或仅转义写法不同）的条目不替换，所以 `"\u2192"`、`"\u2026"`
  这类原样保留，不会被改写成字面的 `→`、`…`；emoji 用真实字符写入，不残留 `\u{...}`。
- **scan 的两道门禁**：在已汉化的文件上扫描会被拒绝（否则会把中文当文案、覆盖掉好的英文快照）；
  `--only` 只写 `data/candidates.partial.json`，不会污染完整快照。
- **全程可回退**：原始文件 gzip 备份在 `work/backups/<commit>/`，`restore` 一条命令还原（含 product.json 校验值）；
  即使 `work/applied.json` 丢了，也会从备份目录重建清单。
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

## 多机器同步

译文库进版本库后，多机器用法就是：`git pull` → `node tools/bootstrap.js`。
每台机器的 `work/config.json`（Cursor 安装路径）、`work/backups/`、`data/candidates.json`
各存各的，互不干扰。想让自己机器上的新译文被别人用到，提交 `data/translations.zh.json` 即可。

