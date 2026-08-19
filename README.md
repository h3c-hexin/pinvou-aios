# Pinvou AIOS

一个以 [Pi](../pi) 为 Agent runtime 的 Linux PAD 形态 AIOS 最小原型。

当前版本只实现一条完整主链路：

- `pinvou-aiosd` 常驻守护进程，通过 Unix Socket 暴露 JSONL API；
- 一个持久化的 Pi RPC 主 Agent；
- 主 Agent 通过扩展工具创建、查询和取消后台任务 Agent；
- 主 Agent 通过单一 `playwright_cli` 工具使用官方 Playwright CLI 的全部命令，控制 AIOS 内置的人机共享 Chromium，同时不获得 Bash；
- React + Electron 的 PAD 桌面壳展示主对话、后台任务和内置 Browser Surface；
- SQLite 保存任务状态，Pi 自己保存会话历史。

语音、MCP、富媒体产物、权限确认和业务连接器暂不在这个最小版本内。

## 前置条件

- Node.js 22+
- Rust 1.85+
- 本地 Pi 仓库位于 `../pi`

首次使用 Pi 源码入口时：

```bash
cd ../pi
npm ci --ignore-scripts
npm run hydrate:model-data
```

安装项目锁定的 Playwright CLI，以及携带专用 Chromium 的 Electron UI：

```bash
npm --prefix browser ci --ignore-scripts
npm --prefix apps/pad-ui ci
```

Linux 开发目录中的 Electron sandbox helper 需要正确权限；正式 `.deb`/系统镜像也应在打包阶段设置：

```bash
sudo chown root:root apps/pad-ui/node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 apps/pad-ui/node_modules/electron/dist/chrome-sandbox
```

主 Agent 没有 `bash` 或 `read`，而是把命令参数作为数组传给 `playwright_cli`；该工具使用 `shell: false` 启动项目锁定的 CLI。默认 Session 是 `pinvou-main`。Electron 把内置 Chromium 的随机本机 CDP 端点写入 `~/.pinvou-aios/run/browser-cdp.json`，CLI 自动附着该端点；如果 UI 未运行，工具会报错而不会回退弹出外部 Chrome。页面操作、调试、网络、存储和数据命令均保留；`open` 被映射为内置页面导航，因此外部浏览器、Profile、浏览器类型和 headed/headless 等启动参数不适用于 Browser Surface。Agent 可以通过 `--help` 渐进发现命令说明。

从任务卡片打开本地 HTML 后，右侧工具栏会启用“AI 修改”：开启后可点击页面元素，再用自然语言描述修改要求。选择层运行在 Browser Surface 的隔离 preload 中，不向普通网页暴露 Electron API；修改请求会恢复生成该产物的原 Worker 会话，先在任务目录的 `.aios/revisions/` 保存快照，再修改源 HTML。文件变化会自动刷新画布并尽量恢复原选择，工具栏支持逐次撤销。普通 HTTP/HTTPS 页面不能进入该编辑模式。

例如主 Agent 可以依次调用：

```json
{"args":["open","https://example.com","--headed"]}
{"args":["--raw","snapshot"]}
{"args":["fill","e5","DeepSeek"]}
{"args":["click","e8"]}
```

Pi 需要至少一个已配置的模型供应商。可以在 Pi 中完成认证，或通过环境变量向守护进程指定：

```bash
export PINVOU_PI_PROVIDER=openai
export PINVOU_PI_MODEL=gpt-5.2
```

## 运行

终端一：

```bash
cd daemon
cargo run
```

也可以安装为当前 Linux 用户的常驻 systemd 服务：

```bash
./scripts/install-user-service.sh
```

终端二启动 Electron PAD UI：

```bash
cd apps/pad-ui
npm start
```

只有本地联调且明确接受关闭 Chromium sandbox 时，才可临时使用 `PINVOU_ELECTRON_NO_SANDBOX=1 npm start`；该模式不得用于正式运行或打开不可信网页。

默认运行数据位于 `~/.pinvou-aios`。可用环境变量覆盖：

- `PINVOU_AIOS_HOME`
- `PINVOU_AIOS_SOCKET`
- `PINVOU_PI_BIN`
- `PINVOU_PI_PROVIDER`
- `PINVOU_PI_MODEL`
- `PINVOU_PLAYWRIGHT_CLI`
- `PLAYWRIGHT_CLI_SESSION`
- `PLAYWRIGHT_MCP_HEADLESS`
- `PLAYWRIGHT_MCP_CONFIG`

协议说明见 [contracts/protocol.md](contracts/protocol.md)。
