# Daemon JSONL protocol

客户端连接 Unix Socket（默认 `~/.pinvou-aios/run/aios.sock`），每行发送一个 JSON 对象：

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
- `surface.modify`：`{ "taskId": "...", "artifactPath": "...", "instruction": "...", "selection": { ... } }`
- `surface.undo`：`{ "taskId": "...", "artifactPath": "..." }`

语音输入产生轻量事件，避免客户端轮询完整快照：

- `main.turn.accepted`
- `main.turn.started`
- `main.turn.delta`
- `main.turn.tool_started`
- `main.turn.completed`
- `main.turn.interrupted`
- `main.turn.failed`
