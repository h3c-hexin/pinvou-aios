# Pinvou AIOS

一个以 [Pi](../pi) 为 Agent runtime 的 Linux PAD 形态 AIOS 最小原型。

当前版本只实现一条完整主链路：

- `pinvou-aiosd` 常驻守护进程，通过 Unix Socket 暴露 JSONL API；
- 一个持久化的 Pi RPC 主 Agent；
- 主 Agent 通过单一 `task` 工具的 `create/list/get/cancel` action 管理后台任务 Agent；daemon 内部仍保留细粒度任务 RPC；
- 主 Agent 通过单一 `playwright_cli` 工具使用官方 Playwright CLI 的全部命令，控制 AIOS 内置的人机共享 Chromium，同时不获得 Bash；
- React + Electron 的 PAD 桌面壳展示主对话、后台任务和内置 Browser Surface；
- Electron 可信 UI 提供单次与连续语音模式，通过 Token Plan 的 `qwen-audio-3.0-asr-flash` 识别后自动进入 Pi 主 Agent；
- Pi 的语音轮次通过增量事件送入按句 TTS，优先使用 `qwen-audio-3.0-tts-plus`，云端不可用时回退本机语音；
- 连续模式在本地做 VAD 分段，用户开口会立即停止当前播放，识别确认后中断旧的 Pi 轮次；
- SQLite 保存任务状态，Pi 自己保存会话历史。

当前连续模式是“本地 VAD + 分句批量 ASR”，还不是服务端流式 ASR。MCP、权限确认和业务连接器暂不在这个最小版本内。

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

主 Agent 没有 `bash` 或 `read`，而是把命令参数作为数组传给 `playwright_cli`；该工具使用 `shell: false` 启动项目锁定的 CLI。默认 Session 是 `pinvou-main`。Electron 的原始调试端口只供本进程内部使用；写入 `~/.pinvou-aios/run/browser-cdp.json` 的是带随机 WebSocket 路径的 Agent CDP Gateway。Gateway 只暴露 Browser Surface 所属的 Chromium Context，拒绝附着、切换或执行到 Pinvou AIOS 特权 UI Renderer。CLI 自动附着该受控端点；如果 UI 未运行，工具会报错而不会回退弹出外部 Chrome。页面操作、调试、网络、存储和数据命令均保留；`open` 被映射为内置页面导航，因此外部浏览器、Profile、浏览器类型和 headed/headless 等启动参数不适用于 Browser Surface。Agent 可以通过 `--help` 渐进发现命令说明。

Worker 通过 `task_complete.artifacts[]` 登记结构化产物；daemon 为每个产物分配稳定 Artifact ID，只保存任务工作区相对路径，并把旧任务的 `HTML_ARTIFACT:` 结果自动迁移。产物所有权与任务卡片引用分开记录，因此历史上的二次修改任务可以安全引用原任务产物，但不会取得该文件的所有权。UI 从 Artifact 索引打开本地 HTML，不再解析 `Task.output` 或在 Renderer 中传递绝对路径。产物打开后会绑定为主 Agent 的当前页面上下文。用户在主对话中提到“当前页面”“这个”或“这里”时，主 Agent 会先通过 Playwright 读取共享 Browser Surface 的最新页面，再回答或继续处理；内部上下文不会写成 UI 中的普通用户消息。用户直接在主对话中要求“修改这个页面”时，主 Agent 使用 `artifact_modify_current` 将要求路由给产物所属的原 Worker Session，不创建第二个任务，也不接收或猜测文件路径。守护进程会先在任务目录的 `.aios/revisions/` 保存快照，并把版本号和修改来源登记到 SQLite，再修改源 HTML；同一任务的每次完成都能产生独立通知。

右侧工具栏也保留元素级“AI 修改”：开启后可点击页面元素，再用自然语言描述修改要求。选择层运行在 Browser Surface 的隔离 preload 中，不向普通网页暴露 Electron API；文件变化会自动刷新画布并尽量恢复原选择，工具栏支持逐次撤销。普通 HTTP/HTTPS 页面不能进入该编辑模式。Worker 只能把自己工作目录内的 HTML 登记为产物，跨任务目录的产物在 `task.complete` 时会被拒绝。

当前 CDP Gateway 是保持 Browser Surface 真正内嵌显示前提下的第一阶段权限隔离：Agent 端无法发现或附着特权 UI target，Browser Surface 自身也被禁止访问 Electron 原始调试端口。后续正式系统仍应把浏览器宿主迁移到独立进程或等价的 OS 隔离边界；不要把 Gateway 当作 Worker 文件系统沙箱或完整主机安全边界。

Browser Surface 打开任务产物前会保存原浏览环境。点击返回或关闭当前任务产物时，会恢复此前的网址、打开状态和滚动位置；若此前也是另一个任务产物，则会恢复它的主 Agent 上下文、元素选择和 AI 修改模式。当前最小实现通过重新导航恢复页面，因此网页中尚未持久化的动态 JS/表单状态不保证保留。

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

语音输入与云端合成使用 Token Plan 个人版专属的 `sk-sp-` API Key。密钥只由 Electron 主进程读取，不会暴露给 React 页面或右侧 Browser Surface。首次通过环境变量启动后，Electron 会用操作系统安全存储加密保存密钥；若系统没有可用的加密后端，则不会落盘：

```bash
export PINVOU_TOKEN_PLAN_API_KEY='sk-sp-...'
```

“单次”模式点击麦克风开始录音，再次点击后停止、识别并自动发送给 Pi；“连续”模式会常驻收音，本地检测一句话结束后自动识别和发送。单次录音上限为两分钟，连续模式单句上限为 30 秒。只有语音发起的 Pi 轮次会被朗读，键盘输入不会突然触发 TTS。Token Plan 个人版应仅按其服务条款用于个人、单设备的交互式智能体工具场景。

可选语音合成设置：

```bash
export PINVOU_TTS_VOICE=longanlingxin
export PINVOU_TTS_WEBSOCKET_URL=wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
```

`qwen-audio-3.0-tts-plus` 的系统音色只能使用 `longanlingxin` 或 `longanlufeng`。不要混用其他 Qwen-Audio-TTS 或 CosyVoice 模型的音色，否则服务端会返回引擎错误 411。

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
- `PINVOU_TOKEN_PLAN_API_KEY`
- `PINVOU_TTS_VOICE`
- `PINVOU_TTS_WEBSOCKET_URL`
- `PLAYWRIGHT_CLI_SESSION`
- `PLAYWRIGHT_MCP_HEADLESS`
- `PLAYWRIGHT_MCP_CONFIG`

协议说明见 [contracts/protocol.md](contracts/protocol.md)。
