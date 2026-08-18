# Pinvou AIOS

一个以 [Pi](../pi) 为 Agent runtime 的 Linux PAD 形态 AIOS 最小原型。

当前版本只实现一条完整主链路：

- `pinvou-aiosd` 常驻守护进程，通过 Unix Socket 暴露 JSONL API；
- 一个持久化的 Pi RPC 主 Agent；
- 主 Agent 通过扩展工具创建、查询和取消后台任务 Agent；
- React + Tauri 的 PAD 桌面壳展示主对话、后台任务状态和文本结果；
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

终端二：

```bash
cd apps/pad-ui
npm install
npm run tauri dev
```

默认运行数据位于 `~/.pinvou-aios`。可用环境变量覆盖：

- `PINVOU_AIOS_HOME`
- `PINVOU_AIOS_SOCKET`
- `PINVOU_PI_BIN`
- `PINVOU_PI_PROVIDER`
- `PINVOU_PI_MODEL`

协议说明见 [contracts/protocol.md](contracts/protocol.md)。
