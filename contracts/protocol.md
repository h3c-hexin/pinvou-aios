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
- `task.complete`：`{ "taskId": "...", "summary": "...", "result": "...", "artifacts": [{ "kind": "html", "path": "index.html", "title": "..." }] }`；`artifacts` 可省略，旧版 `HTML_ARTIFACT:` 首行仍兼容迁移
- `task.cancel`：`{ "taskId": "..." }`
- `artifact.resolve`：`{ "artifactId": "..." }`，由可信桌面宿主把 Artifact ID 解析为经过工作区校验的本地文件；不向 Agent 工具直接暴露
- `surface.activate`：`{ "contextId": "...", "artifactId": "..." }`，将当前 Artifact 绑定到主 Agent 对话上下文
- `surface.deactivate`：`{ "contextId": "..." }`，仅在 contextId 仍匹配时解除当前产物上下文；省略 contextId 可清理陈旧上下文
- `surface.modify`：`{ "artifactId": "...", "instruction": "...", "selection": { ... } }`
- `artifact.modify_current`：`{ "instruction": "..." }`，由主 Agent 修改当前绑定的完整 HTML 画布；守护进程自动定位产物、保存版本并恢复原 Worker Session
- `surface.undo`：`{ "artifactId": "..." }`

首版协议仍接受旧的 `taskId + artifactPath` Surface 参数，以便迁移已经保存的任务；新客户端只应传递 `artifactId`。Task Snapshot 中的 `artifacts[]` 是产物权威索引，`Task.output` 仅保留人类可读结果，不再承担产物发现职责。

语音输入产生轻量事件，避免客户端轮询完整快照：

- `main.turn.accepted`
- `main.turn.started`
- `main.turn.delta`
- `main.turn.tool_started`
- `main.turn.completed`
- `main.turn.interrupted`
- `main.turn.failed`
