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
- `task.create`：`{ "title": "...", "objective": "..." }`
- `task.list`
- `task.status`：`{ "taskId": "..." }`
- `task.progress`：`{ "taskId": "...", "message": "...", "percent": 30 }`
- `task.complete`：`{ "taskId": "...", "result": "..." }`
- `task.cancel`：`{ "taskId": "..." }`

