# cursor-zh

把 Cursor 桌面端**自有界面**翻成简体中文的本地补丁工具：Agent 窗口、Cursor 设置页、账号页、Automations。

## 为什么需要它

Cursor 的 `Configure Display Language` 只能翻译从 VS Code 继承的外壳（菜单、命令面板、标准设置项），
因为它依赖 `out/nls.messages.json` 里的键；而 Cursor 自有界面的英文**直接写在编译后的 JS 文件里**，
语言包碰不到。这个工具补的就是这一块：扫描出界面文案 → 用自带译文替换 → 校验后落盘。

## 安装与使用

前提：目标机器装了 **Node.js ≥ 16**。

```bash
git clone https://github.com/haxsd/cursor-zh.git
cd cursor-zh
node tools/bootstrap.js --check   # 先看：装在哪、什么版本、补丁在不在、还差多少译文
node tools/bootstrap.js           # 一键：检测 → 扫描 → 打补丁 → 审计
```

译文库随仓库一起来，**不需要任何 API 密钥**。只有目标机器的 Cursor 出现仓库里没有的新文案时才需要翻译
（加 `--with-ai`，或跳过让它保持英文）。打完重启 Cursor 生效；想回到英文用 `node src/cli.js restore`。

**macOS 额外说明**：`apply` 会自动清隔离属性（`xattr -cr`）并重做 ad-hoc 签名
（`codesign --force --deep --sign -`）——改动了 `Cursor.app` 里的文件后签名会失效，缺这一步系统会拒绝启动
（提示"已损坏"或 `zsh: killed`）。如果 Cursor 装在 `/Applications` 且当前用户没有写权限，
先完全退出 Cursor，再用 `sudo node tools/bootstrap.js`。

**Windows / Linux** 无额外步骤。常见安装位置（`%LOCALAPPDATA%\Programs\cursor`、
`C:\Program Files\Cursor`、`/opt/Cursor`、`/usr/share/cursor`、`~/.local/share/cursor` 等）会自动找到；
定位不到时用 `node src/cli.js doctor --app-dir="<Cursor>/resources/app"` 显式指定。

常用子命令：`node src/cli.js <status|scan|plan|apply|restore|...>`，不带参数运行会打印完整列表；
改动原理与安全设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## Cursor 升级后

**中文会变回英文，但不会坏。** 升级会整体覆盖被改的那几个打包文件（连同我们的改动），
`product.json` 也由升级程序重写，所以既不会崩溃、也不会报"安装已损坏"。译文按英文原文索引，
升级后能命中的直接复用——最近一次升级（3.24.12 → 3.24.18）4,694 条里只有 3 条需要新翻译。

重打一次即可（约 1–2 分钟）：

```bash
node src/cli.js scan      # 必须：替换坐标要按当前版本的文件重新记录
node tools/bootstrap.js   # 或手动：apply → audit
```

升级后**不要**跑 `restore`：升级已经覆盖了那些文件，没有"中文残留"要清；而且此时备份还是上一版的，
`restore` 会核对版本并拒绝执行（防误操作）。同一版本内想回到英文才用它。

## 已知边界

- **命令面板按英文搜命令会搜不到**：汉化方案的固有代价。
- **仍有英文残留**：专有名词、URL、代码标识符（`verify` 报告里约 200 条属有意保留），
  以及同时用作存储键或协议值的功能性字符串。
- **走 NLS 通道的文案未覆盖**：菜单栏、命令面板、右键菜单、标准设置项来自 `out/nls.messages.json`，
  需要官方中文语言包 + `locale: zh-cn` 才会变中文；Cursor 自己的少量 NLS 文案（如
  `Open Cursor Settings`、`Show Agents Side Bar`）官方语言包不含，本项目暂未覆盖。
- 截图、Webview 内嵌页面、Cursor 服务端返回的文案不受影响。

## 免责与致谢

- **非官方**工具，与 Anysphere（Cursor）、Microsoft 无关；它修改的是本机 Cursor 安装目录里的程序文件，
  属于社区同类做法。思路参考 [polang233/cursor-language-pack](https://github.com/polang233/cursor-language-pack)
  与 [rongwei-lab/cursor-chinese](https://github.com/rongwei-lab/cursor-chinese)（均为 MIT）：同样靠改写
  编译后的 JS 包并同步 `product.json` 校验值。本项目的差异是**先扫描出带区间的候选集再翻译**，
  替换坐标显式化，并带落盘审计门禁；译文与词表为自建。
- 边界：只在 UI 字段上下文替换、落盘前语法校验、写入后审计、全程可回退。
- 分享给别人时**不要**带上 `work/` 目录（里面有本机路径和安装目录备份）；
  `data/translations.zh.json` 才是值得共享的资产。
- 协议：MIT。

## 多机器同步

`git pull` → `node tools/bootstrap.js`。译文库进版本库；`work/`（本机路径、备份）与
`data/candidates.json`（按当前版本扫描出的替换坐标）各机器各存各的。
