# Changelog

All notable changes to **AGY Claude Style · Focus & Starlight Edition (`agy-claude-style-focus`)** are documented in this file.

## [v2.2.0] - 2026-11-24

`v2.2.0` 为基于上游 `0DNANCY/agy-claude-style` `v2.1.0` 的专注生产力与星轨互动增强版：新增 **小螃蟹流星御风巡游与空中许愿彩蛋**、**深潜专注模式 + 番茄冲刺计时胶囊**、**右下角双同心圆环（`dual` 上下文+配额同显）**、**大草稿与单轮 Token 暴增守门员** 及 **4 组全局键盘快捷键**，并修复了上游 Windows Node 路径含空格时的单测命令引号问题。

### 🌠 星轨御风互动与专注生产力流（`focus-core.js`）
- **小螃蟹流星御风巡游（`meteorRide: auto | manual | off`）**：
  - 闲置未打字（≥45 秒）且未开启深潜专注时，周期性召唤发光流星从输入框侧翼俯冲迎驾，接起 `Clawd` 沿三次平滑抛物星轨横跨输入框上空滑翔返航。
  - **空中点击许愿彩蛋**：飞行途中点击小螃蟹或流星，触发星尘许愿气泡（`✦ 许愿成功！灵感满格 ✦`）与 `Clawd` 欢呼动作；支持 `Alt+Shift+M` 或 `Shift + 单击小螃蟹` 随时手动召唤。
- **深潜专注模式（`focusMode` · `Alt+Shift+F`）**：
  - 一键静默首页动态波纹与对话轮次徽章噪声，将小螃蟹锁定为安静戴耳机陪伴态并自动暂停流星巡游，退出后无损恢复原设置。
- **番茄冲刺计时胶囊（`sprintMinutes: 25 | 45 | off` · `Alt+Shift+P`）**：
  - 输入框底栏内嵌极简倒计时胶囊（左键启停、右键重置），倒计时达成时自动召唤**专属金色庆典流星**带着小螃蟹撒花巡游并提醒起身休息 2 分钟。

### 🛡️ 双同心圆环与 Token 成本守门员（`usage-core.js`）
- **右下角双同心圆环（`ringMode: dual` 默认启用）**：
  - 外环实时展示当前对话上下文余量百分比，内环同步展示账号模型配额余量百分比，无需在 `context` 与 `quota` 间来回切换；点击时自动跳转至余量更紧迫的遥测分栏。
- **大草稿与单轮暴增守门员（`costGuard`）**：
  - 当输入框实时草稿预估 `≥ 4,000 tokens` 或上一轮上下文单次激增 `≥ 15,000 tokens` 时，在输入框顶部弹出琥珀色/珊瑚红提醒条，提供一键 `/compact` 压缩与本轮忽略操作。
- **全局快捷键与 5 语言设置集成**：
  - 新增 `Alt+Shift+F`（深潜专注）、`Alt+Shift+P`（冲刺计时）、`Alt+Shift+M`（召唤流星）、`Alt+Shift+T`（开关遥测浮窗），并在 `设置 → 外观` 扩展至 24 项 5 语言可视化开关。

---

## [v2.1.0] - 2026-11-22

`v2.1.0` 新增 **Swarm 蜂群侧栏（`/swarm` 面板）与 Plan / Orchestrator 模式完整 5 语言本地化**（#15），并修复了长对话虚拟列表及模型思考阶段输出下方轮次 HUD（`#T` 徽章）可能出现历史或残缺虚假信息的问题。

### 🌐 语言支持增强（Swarm UI 侧栏 & Plan / Orchestrator 模式，#15）
- **Swarm 蜂群侧栏（`/swarm` 面板）完整 5 语言本地化**：
  - Node（`cdp.js`）、Windows C#（`CdpClient.cs`）与 macOS Swift（`CdpClient.swift`）三端 CDP 目标过滤统一支持 `plugin://swarm--` 侧栏 OOPIF `iframe` 目标，并自动随主窗口语言切换通过轻量 `refreshConfig` 实时同步。
  - 新增 `sidecar-core.js` 侧栏精简运行时：在 `plugin:` 协议上下文下跳过主窗口 `style.css` 与 UI 增强，仅挂载可逆 DOM 翻译器，精准保护帖子正文、成员句柄、任务描述与叙述者视图，同时放行 `<select><option>` 筛选选项翻译，卸载时无损还原。
- **Plan / Orchestrator / Coordinator / Plugins 词典补齐**：
  - 扩充 `i18n-locales.js` 约 180+ 条 5 语言静态词条与 25 条动态正则规则，覆盖 Swarm 面板（Overview / Board / Members / Graph / Raw / Hive / Replay / GIF 导出）及主窗口新版 Orchestrator 模型设置、Coordinator/Subagent 控件、Pause/Resume 提示与插件管理界面。

### 🐛 Token HUD 轮次徽章（`#T`）精准对齐与思考态防串位修复
- **消除长对话思考阶段 `#T` 徽章盗用历史轮次问题**：
  - 修复在长对话虚拟列表仅挂载最近若干轮次（如 `#T12`～`#T20`）时，新提问处于“工作中 / 思考中”阶段因 `matchTurnByFiber` 返回 `null` 而掉入 `remainingTurns` 尾部回退队列、导致 `#T20` 下方的思考中节点错误挂载未渲染历史轮次（如 `#T11`）的问题。
  - 对缺失 Fiber 定位器的降级匹配施加严格的 DOM 先后单调性约束，并禁止自身已携带 Fiber 索引/时间戳的新轮次节点进入降级回退队列。
- **禁止进行中（思考中 / 流式生成中 / 工具执行中）轮次提前挂载残缺 HUD**：
  - 在 `usage-core.js` 中为仍包含 `status === 1` / `status === 2` 步骤或正在等待工具调用后模型响应的轮次标记 `inProgress: true`；在 `ui-runtime.js` 的 `extractFiberTurnContainer` 与多响应合并 `mergeFiberInfo` 中追踪 `hasRunningStep` / `isEmptySteps`（同时覆盖主会话与子智能体面板），确保模型思考期间下方不出现半成品或虚假 HUD，待生成完成后立即挂载完整 `#T` 统计。
- **防御发送瞬间缓存窗口期抢占与 0-Token 启动占位**：
  - 防止刚按下发送键、轨迹轮询尚未闭合上一轮 `nextUserStepIdx`（仍为 `Infinity`）的瞬间，新插入的 DOM 轮次节点覆盖抢占上一轮的 `#T` 徽章。
  - 过滤 `generatorMetadata` 启动期仅有 `chatStartMetadata` 尚无 `usage` token 的占位条目进入 `callList`（同时保留其实时上下文窗口占用更新）。

### 🧪 自动化测试扩充
- 全平台自动化测试扩展至 **90 项**（新增 Swarm 侧栏翻译器与 OOPIF 目标发现测试、20 轮虚拟列表 + 第 21 轮思考中四阶段防串位回归测试及未完成调用过滤测试）。

**Full Changelog**: https://github.com/0DNANCY/agy-claude-style/compare/v2.0.0...v2.1.0

---

## [v2.0.0] - 2026-11-21

`v2.0.0` 为重大架构与体验升级版本：正式引入 **「启动器托管模式（随宿主生灭、零后台常驻）」**（#4、#14），并全面整合 **PR #13**（@zhyan0603 / ZihanYAN）在守护进程安全加固、轻量配置热更新与 Token HUD 方面的深度优化。

### 🚀 启动器托管模式与双模式切换（#4、#14）
- **三端统一无窗启动器（`--launch` / `--managed`）**：
  - Windows `agy-claude-style-watcher.exe` 与 macOS `agy-claude-style-watcher` 新增 `--launch`、`--relaunch`、`--replace`、`--startup-grace <sec>`（默认 `90` 秒），Node 端 `inject.js` 同步新增 `--managed` 一键组合参数与 `npm run managed`。
  - 启动时优先复用并激活已有 CDP 窗口；未运行或未开启 CDP 时按参数/配置以 `--remote-debugging-port=0` 启动或温和重启，随后直接进入 `--exit-on-host-close` 监听并在宿主关闭后自动退出。
  - 新增重复实例去重（托管启动不重复驻留）与 **90 秒启动宽限保护**：若在首个窗口附着前宿主启动失败或中途关闭，watcher 会在宽限期后自动退出并清理 `.watch.pid`，避免孤儿进程挂起；普通 `--watch` 守护模式即使配置了 `exitOnHostClose: true` 也不会误触发宽限退出。
- **Windows 与 macOS 独立安装器双模式改造**：
  - 安装器 GUI 与 CLI 均默认推荐 **托管启动模式（免后台常驻）**，同时完整保留 **常驻守护模式（开机自启）**，支持 `--mode=managed|daemon`、`--managed`、`--daemon`、`--desktop-shortcut` / `--no-desktop-shortcut`（Windows）、`--app-launcher` / `--no-app-launcher`（macOS），并兼容 `--no-autostart`。
  - 托管模式下平时 **0 后台进程常驻**：不写入 Windows Startup / macOS `LaunchAgent`；仅当安装时检测到 Antigravity 已开启 CDP 会话才拉起一次性 `--exit-on-host-close` 监听接管当前会话。
  - 升级自动保留已有 `config.json` 并通过 `.install-mode` 记录当前模式；从常驻模式切换至托管模式时，主动删除旧版 Startup 快捷方式 / `LaunchAgent` plist 并停止原常驻进程；卸载时一并清理所有启动入口。
  - 统一启动入口：Windows 安装目录、开始菜单及桌面生成 `Antigravity (AGY Claude Style).lnk`（指向无黑框 watcher `--launch --relaunch --exit-on-host-close`）；macOS 生成 `Antigravity (AGY Claude Style).app` 与 `launch-antigravity.command`。
- **脚本模式升级**：
  - `launch.bat` 与 `launch.sh` 默认以托管模式启动并在关闭宿主后自动退出，传入 `--daemon` 可切回常驻守护模式；`watch-hidden.vbs` 支持命令行参数透传（无参保持默认 `--watch --replace`）。
- **零侵入安全原则**：全程不改动 Antigravity 原版安装目录，不使用 DLL 劫持或 IFEO 映像劫持，避免安全软件误报并保持 Windows / macOS / Linux 跨平台统一。

### 🛡️ 守护进程安全加固与轻量配置热更新（整合自 #13，致谢 @zhyan0603）
- **Fail-Closed PID 归属校验**：
  - 在 `cdp.js`、`inject.js`、`remove.js` 与 Windows C# / macOS Swift 安装器及守护进程中引入严格进程归属判定，综合校验可执行文件路径、命令行参数、`--dir` 及 macOS `/private/(var|tmp|etc)` 软链路径（支持 `--watch` 与 `--managed`）。
  - 仅终止确认属于目标安装目录的守护进程；遇到失效或属于其他程序的 PID 仅清理锁文件而不误杀；进程信息无法确认时执行 **Fail-Closed 拒绝策略**，既不发信号也不覆盖 `.watch.pid`。
  - `watch.sh` 与 `launch.sh` 统一改用 `$PWD/inject.js` 绝对路径启动，消除相对路径判重盲区；Windows 卸载自删除改用编码 PowerShell `-LiteralPath` 安全处理特殊路径字符。
- **`<2KB` 轻量配置热更新与三方配置合并**：
  - 将页面注入脚本拆分为不可变完整运行时（`bootstrapScriptId`）与独立短配置脚本（`configScriptId`）。仅编辑 `config.json` 或在面板切换设置时，仅下发 `<2KB` 配置脚本并触发 `window.__agClaudeStyle.refreshConfig()`，避免重复传输整包运行时与样式表；新开窗口、页面重载及轻量刷新回退时均保持最新配置生效。
  - 共享 `CONFIG_VALIDATORS` 单一校验源并消除重复校验表；`config.json` 改用临时文件原子替换写入（替换失败保留原文件）；前端 `loadSettings` 对前后配置快照与 `localStorage` 执行 **3-way 合并**，保留本地 UI 偏好不被外部非相关变更覆盖；对齐三端 `autoRelaunchWithCdp` 缺省值为 `true`，Windows `MiniJson.cs` 补齐 `\u2028`/`\u2029` 转义。

### 📊 Token HUD 增强与运行时性能优化（整合自 #13）
- **低上下文预警与精准 `/compact`**：上下文剩余 `<= 20%`（琥珀色预警）及 `<= 10%`（红色紧急）时，状态环、顶部 HUD `/compact` 按钮与详情浮窗同步展示提醒并支持点击一键填充 `/compact`；多会话视图下优先向当前卡片关联输入框填入指令。
- **配额联动与剪贴板反馈**：开启底部 HUD（`hudBottomBar`）时，即使圆环处于 `context` 模式也会同步拉取模型配额；点击复制遥测报告在剪贴板拒绝或失败时显示明确 `✕ 失败` 状态反馈。
- **绘制与缓存优化**：草稿输入时的弹层数据刷新通过 `requestAnimationFrame` 合并并优先局部更新数字节点；过滤非输入区的 `.monaco-editor` 与 `.xterm` 高频 DOM 变更；为主会话与子代理轨迹缓存增加 LRU 淘汰；首页字符波纹静止时跳过冗余计算并在零尺寸容器下安全创建与卸载绘制资源。

### 🧪 自动化测试扩充
- 全平台自动化测试扩展至 **84 项**（覆盖托管启动、90s 启动宽限、重复实例去重、Windows/macOS 双模式切换与卸载 E2E、fail-closed PID 归属保护、原子配置替换、`<2KB` 轻量热更新、低上下文预警及零尺寸波纹卸载）。

**Full Changelog**: https://github.com/0DNANCY/agy-claude-style/compare/v1.3.0...v2.0.0

---

## [v1.3.0] - 2026-11-20

- **Remote（Cloud）模式 Token HUD 与用量遥测支持（#11）**：接入 `AgentState` 流式遥测与状态订阅，解决 Remote 会话下 HUD、状态条、内联统计与 `#T` 轮次徽章缺失的问题，并支持带有 `v1/default/jetski_remote_agents_3p/...` 前缀的 `cascadeId` 与更准确的模型上下文上限/速度统计。
- **CI / Release 工作流优化与产物命名统一（#12）**：引入共享工作流 `.github/workflows/_build-and-test.yml`，统一输出 `AGY-Claude-Style-v<version>-Windows-x64.exe`、`AGY-Claude-Style-v<version>-macOS-universal.dmg` 与 `SHA256SUMS.txt`。

**Full Changelog**: https://github.com/0DNANCY/agy-claude-style/compare/v1.1.1...v1.3.0

---

## [v1.1.1] - 2026-11-20

- 修复 PR #8 复查反馈的问题（#9、#10）：加固 CDP 自动重启接管前对原生可执行路径的校验，修复流式回复阶段 `#T` 徽章跳位与用量统计双倍计数，并降低全局 DOM 监听开销。

**Full Changelog**: https://github.com/0DNANCY/agy-claude-style/compare/v1.1.0...v1.1.1

---

## [v1.1.0] - 2026-11-20

- 适配 **Antigravity 2.33.0+** 默认关闭 CDP 调试端口的变更（#2、#3、#5、#6、#7、#8）：新增 `--launch` / `--relaunch`、默认启用 `autoRelaunchWithCdp`、Windows 开始菜单启动快捷方式与 macOS `launch-antigravity.command`，修复 Token HUD 实时刷新、对话轮次统计与侧边栏样式。

**Full Changelog**: https://github.com/0DNANCY/agy-claude-style/compare/v1.0.0...v1.1.0

---

## [v1.0.0] - 2026-11-15

- 首个公开版本（#1）：基于 CDP 的 Antigravity 无损实时样式注入、Studio 首页与字符波纹场、Token HUD、5 语言翻译、像素螃蟹 `Clawd`、思考强度滑块，以及 Windows（C#）与 macOS（Swift Universal）独立免 Node.js 安装器。
