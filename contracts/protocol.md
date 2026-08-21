# Daemon JSONL protocol

客户端连接本地 IPC，每行发送一个 JSON 对象。Linux/macOS 默认使用 Unix Socket
`~/.pinvou-aios/run/aios.sock`；Windows 默认使用 TCP `127.0.0.1:57931`。
可用 `PINVOU_AIOS_SOCKET` 或 `PINVOU_AIOS_TCP_ADDR` 覆盖。

```json
{"id":"1","method":"snapshot.get","params":{}}
```

响应：

```json
{"id":"1","ok":true,"result":{}}
```

连接还会收到无请求 ID 的状态事件：

```json
{"type":"event","event":"snapshot.changed","seq":12,"data":{}}
```

首版方法：

- `snapshot.get`
- `main.prompt`：`{ "message": "..." }`
- `main.voice_prompt`：`{ "message": "...", "turnId": "voice:..." }`
- `main.interrupt`：中断当前主 Agent 轮次
- `task.create`：`{ "title": "...", "objective": "..." }`
- `task.list`
- `task.status`：`{ "taskId": "..." }`
- `task.progress`：`{ "taskId": "...", "message": "...", "percent": 30 }`
- `task.complete`：`{ "taskId": "...", "result": "..." }`
- `task.cancel`：`{ "taskId": "..." }`
- `surface.activate`：`{ "contextId": "...", "taskId": "...", "artifactPath": "..." }`，将当前任务 HTML 绑定到主 Agent 对话上下文
- `surface.deactivate`：`{ "contextId": "..." }`，仅在 contextId 仍匹配时解除当前产物上下文；省略 contextId 可清理陈旧上下文
- `surface.modify`：`{ "taskId": "...", "artifactPath": "...", "instruction": "...", "selection": { ... } }`
- `artifact.modify_current`：`{ "instruction": "..." }`，由主 Agent 修改当前绑定的完整 HTML 画布；守护进程自动定位产物、保存版本并恢复原 Worker Session
- `surface.undo`：`{ "taskId": "...", "artifactPath": "..." }`

语音输入产生轻量事件，避免客户端轮询完整快照：

- `main.turn.accepted`
- `main.turn.started`
- `main.turn.delta`
- `main.turn.tool_started`
- `main.turn.completed`
- `main.turn.interrupted`
- `main.turn.failed`
