# Pinvou AIOS 前端交接说明

## 当前目标

这个分支正在把 Pinvou AIOS 调整成一个更干净的桌面 AI 工作区：

- 左侧是主对话区。
- 右侧是内置 Chromium 浏览区。
- 后台任务不再占一个常驻侧栏，只有存在任务时才在输入框上方显示轻量任务卡片。
- 浏览器、天气、搜索、网页查看类请求应直接使用右侧浏览区，不应创建后台任务。

## 主要入口

- React UI: `apps/pad-ui/src/main.tsx`
- UI 样式: `apps/pad-ui/src/styles.css`
- Electron 主进程: `apps/pad-ui/electron/main.mjs`
- Electron preload: `apps/pad-ui/electron/preload.cjs`
- daemon: `daemon/src/main.rs`
- 主 Agent 提示词: `profiles/main.md`
- 浏览器工具扩展: `extensions/aios-runtime.js`
- DeepSeek 桥接脚本: `scripts/deepseek-pi.mjs`

## 本地运行

先确保根目录 `.env` 存在，并填写本地密钥，不要提交：

```env
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
PINVOU_PI_MODEL=deepseek-v4-flash
PINVOU_AIOS_TCP_ADDR=127.0.0.1:57931
```

Windows 下启动：

```powershell
.\scripts\start-daemon-windows.ps1
```

另开终端：

```powershell
.\scripts\start-electron-windows.ps1
```

前端验证：

```powershell
cd apps\pad-ui
npm run build
```

浏览器工具依赖：

```powershell
npm --prefix browser ci --ignore-scripts
```

注意：Windows 下不要直接 `spawn` 无后缀 shim 或 `.cmd`。`browser/runner.js` 会把 `playwright-cli` 调用转成 `node browser/node_modules/@playwright/cli/playwright-cli.js ...`，并优先使用本机可用的 Node 22。当前机器上的 Node 24 会让 `@playwright/cli` 退出时触发 Node/UV 断言。

## 当前交互结构

### 左侧对话区

文件：`apps/pad-ui/src/main.tsx`

核心元素：

- `message-stream`: 消息列表。
- `composer`: 底部输入框。
- `TaskChip`: 后台任务轻量卡片。
- `process-strip`: 有后台任务时显示，位置在输入框上方。
- `manualTask`: 点击输入框左下角 `+` 创建手动后台任务。
- `theme-toggle`: 顶栏右侧 iOS 风格圆形外观按钮。

主题切换逻辑：

- 当前是单个圆形 toolbar 按钮：
  - 浅色模式显示太阳图标。
  - 深色模式显示月亮图标。
  - 点击后在浅色和深色之间切换。
- 状态保存在 `localStorage`，key 是 `pinvou-theme-mode`。
- React 会给 `document.documentElement` 设置 `data-theme="light"` 或 `data-theme="dark"`。
- 旧版本保存的 `system` 会在初始化时按当前系统偏好迁移为 `light` 或 `dark`。
- UI 不再暴露“跟随系统”，避免显示器图标含义不清。

任务卡片逻辑：

- 没有任务时不显示。
- 有任务时最多显示最近 3 个。
- 点击任务卡片会调用 `openTask(task)`：
  - 有 `HTML_ARTIFACT` 时在右侧浏览区打开。
  - 没有 HTML 产物时打开任务详情弹窗。
- 运行中任务显示进度条和取消按钮。

### 右侧浏览区

核心元素：

- `browser-toolbar`: 顶部浏览器工具栏。
- `browser-address`: URL 输入框。
- `browser-go`: iOS 风格小圆形打开按钮，只显示外链图标。
- `browser-viewport`: Electron `WebContentsView` 的占位区域。

当前设计决策：

- 右上角“打开”按钮不再使用大号蓝色文字按钮。
- `File / Edit / View / Window` 菜单栏已隐藏，见 `Menu.setApplicationMenu(null)`。
- 右侧空状态不显示大块引导卡片，避免假 UI。
- App 深色模式只负责外层 UI。右侧网页是独立页面，只有网站支持 `prefers-color-scheme` 时才会自动变暗；Bing、百度等搜索页可能仍然白底，这是网页自身样式，不是 React UI 样式缺失。

## Agent 行为约束

文件：`profiles/main.md`

已经明确写入：

- 天气查询、搜索资料、打开网页、查看网页内容、网页操作必须直接使用 `playwright_cli`。
- 上述请求不要创建后台任务。
- 后台任务完成后，引导用户点击对话区底部任务卡片，而不是“右侧任务卡片”。

这一点很重要，因为当前 UI 已经去掉了常驻任务侧栏。

## daemon / Electron 数据流

简化链路：

1. React 通过 `window.pinvou.daemonRequest(...)` 调 daemon。
2. Electron preload 转发 IPC。
3. Electron main 通过 TCP `127.0.0.1:57931` 调 daemon。
4. daemon 启动 Pi 兼容进程。
5. 当前开发模式下 Pi 兼容进程是 `scripts/deepseek-pi.mjs`。
6. DeepSeek 桥接脚本负责普通回复和工具调用。

Windows TCP 支持已经加在：

- `daemon/src/main.rs`
- `apps/pad-ui/electron/main.mjs`
- `apps/pad-ui/electron/daemon-events.mjs`
- `apps/pad-ui/src-tauri/src/main.rs`
- `extensions/aios-runtime.js`

主题同步链路：

1. React 主题开关调用 `window.pinvou.setThemeMode(mode)`。
2. `apps/pad-ui/electron/preload.cjs` 转发到 IPC `theme:set`。
3. `apps/pad-ui/electron/main.mjs` 调 `nativeTheme.themeSource = mode`。
4. Electron 会把 `prefers-color-scheme` 传给内置 `WebContentsView`。
5. 支持暗色偏好的网页会跟随；不支持的网站仍保持自身颜色。

注意：`apps/pad-ui/electron/main.mjs` 的 `applyAppTheme` 仍兼容 `system`，但当前 React UI 只会传 `light` 或 `dark`。

## DeepSeek 桥接现状

文件：`scripts/deepseek-pi.mjs`

当前支持：

- `get_state`
- `get_messages`
- `prompt`
- `abort`
- DeepSeek Chat Completions。
- OpenAI/DeepSeek function calling 工具循环。
- 主 Agent 工具：
  - `playwright_cli`
  - `artifact_modify_current`
  - `task_create`
  - `task_list`
  - `task_status`
  - `task_cancel`
- Worker 工具：
  - `read`
  - `write`
  - `edit`
  - `bash`
  - `task_progress`
  - `task_complete`

已修过的协议坑：

- daemon 发给 Pi 的命令字段是 `type`，不是 `command`。
- 桥接脚本现在兼容 `msg.command || msg.type`。
- Pi 事件必须使用 daemon 期望的结构，例如：
  - `message_start` 需要 `message.role`
  - `message_update` 需要 `assistantMessageEvent.type`
  - 文本增量是 `assistantMessageEvent.delta`
  - `message_end` 需要完整 `message.content`

## 最近 UI 改动

- 移除左侧图标 rail 和常驻任务侧栏。
- 移除 macOS 红黄绿假窗口按钮。
- 移除右侧浏览器空状态大卡片。
- 右侧“打开”按钮改成 iOS 风格圆形图标。
- Electron 菜单栏隐藏。
- 任务卡片恢复到对话区底部，仅有任务时显示。
- 更新主 Agent 提示词，避免网页类请求错误创建后台任务。
- 增加 iOS 风格圆形主题按钮：React 写入 `data-theme`，Electron 同步 `nativeTheme.themeSource`。
- 修复用户蓝色气泡在手动主题覆盖下变成黑字的问题；用户消息应始终是 iOS 蓝底白字。
- 深色模式下 `process-strip` 不再铺一整条深色横条，只保留浮动任务卡。
- 移除“跟随系统”显示器按钮；顶栏不使用 Settings 风格绿色开关，改为更符合 toolbar 的圆形图标按钮。

## 已知问题和下一步

- 旧聊天记录里仍会保留之前 stub 或错误提示，这是历史数据，不代表当前代码状态。
- 如果重启 daemon，Electron 可能短暂出现 `ECONNREFUSED`，重启 Electron 可恢复事件订阅。
- Windows 下如果再次出现 `spawn EINVAL`，优先检查 `browser/runner.js` 是否仍在绕开 `.cmd`，以及 `C:\Users\123\.workbuddy\binaries\node\versions\22.22.2\node.exe` 是否存在。
- “查天气”是否真的打开右侧页面取决于模型是否调用 `playwright_cli`；提示词已约束，但仍建议继续测试并在必要时增加前端快捷意图或 daemon 侧规则。
- 后台任务入口现在是轻量任务条，不是完整任务管理视图；如果任务会越来越多，需要补一个任务抽屉或任务历史页。
- 不建议强行给右侧任意网页注入暗色 CSS。那会破坏页面原样展示、影响 Playwright 观察结果，也可能让网页内容可读性更差。
- 当前 `.env` 不应提交，任何已暴露过的 API key 都应在供应商后台轮换。

## 接手建议

1. 先跑 `npm run build` 和 Windows 启动脚本，确认基础链路。
2. 用“查广州天气”验证：应直接打开/操作右侧浏览区，不应创建后台任务。
3. 用 `+` 手动创建一个后台任务，确认输入框上方出现任务卡片。
4. 点击任务卡片验证详情弹窗和 HTML 产物打开逻辑。
5. 继续收敛 UI：对话气泡、输入框、任务条、浏览器 toolbar 应保持轻量 iOS 风格，不要再加入大面积装饰背景或假窗口元素。
6. 点击顶栏深色模式开关，检查主对话、输入框、任务卡片、浏览器 toolbar、弹窗和错误提示的对比度。
7. 验证右侧网页暗色表现时，注意区分 App 外壳主题和网页自身主题。
