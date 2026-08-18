use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    process::Command,
    sync::{RwLock, broadcast, mpsc},
};
use tracing::{error, info, warn};
use uuid::Uuid;

#[derive(Clone)]
struct Config {
    root: PathBuf,
    socket: PathBuf,
    pi_bin: PathBuf,
    extension: PathBuf,
    main_prompt: String,
    worker_prompt: String,
    provider: Option<String>,
    model: Option<String>,
}

impl Config {
    fn load() -> Result<Self> {
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .context("daemon must live inside the project")?
            .to_path_buf();
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .context("HOME is not set")?;
        let root = env::var_os("PINVOU_AIOS_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".pinvou-aios"));
        let socket = env::var_os("PINVOU_AIOS_SOCKET")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("run/aios.sock"));
        let pi_bin = env::var_os("PINVOU_PI_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| project.join("../pi/pi-test.sh"));
        let extension = project.join("extensions/aios-runtime.js");
        let main_prompt = fs::read_to_string(project.join("profiles/main.md"))?;
        let worker_prompt = fs::read_to_string(project.join("profiles/worker.md"))?;

        Ok(Self {
            root,
            socket,
            pi_bin,
            extension,
            main_prompt,
            worker_prompt,
            provider: env::var("PINVOU_PI_PROVIDER").ok(),
            model: env::var("PINVOU_PI_MODEL").ok(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TaskState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl TaskState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }

    fn from_str(value: &str) -> Self {
        match value {
            "queued" => Self::Queued,
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Interrupted,
        }
    }

    fn active(&self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskView {
    id: String,
    title: String,
    objective: String,
    state: TaskState,
    progress: u8,
    progress_message: String,
    summary: String,
    output: String,
    error: Option<String>,
    session_id: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskNotification {
    event_id: String,
    event_type: String,
    task_id: String,
    title: String,
    summary: String,
    result_ref: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    id: String,
    role: String,
    text: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MainAgentView {
    session_id: String,
    status: String,
    streaming_text: String,
    error: Option<String>,
    messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    seq: u64,
    main: MainAgentView,
    tasks: Vec<TaskView>,
}

struct RuntimeState {
    seq: u64,
    main: MainAgentView,
    tasks: HashMap<String, TaskView>,
}

#[derive(Clone)]
struct AgentHandle {
    tx: mpsc::Sender<Value>,
}

struct Store {
    connection: Mutex<Connection>,
}

impl Store {
    fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS settings (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tasks (
               id TEXT PRIMARY KEY,
               title TEXT NOT NULL,
               objective TEXT NOT NULL,
               state TEXT NOT NULL,
               progress INTEGER NOT NULL,
               progress_message TEXT NOT NULL,
               summary TEXT NOT NULL DEFAULT '',
               output TEXT NOT NULL,
               error TEXT,
               session_id TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS messages (
               id TEXT PRIMARY KEY,
               role TEXT NOT NULL,
               text TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS notification_outbox (
               event_id TEXT PRIMARY KEY,
               task_id TEXT NOT NULL UNIQUE,
               payload TEXT NOT NULL,
               state TEXT NOT NULL DEFAULT 'pending',
               attempts INTEGER NOT NULL DEFAULT 0,
               last_attempt_epoch INTEGER,
               sent_at TEXT
             );",
        )?;
        let has_summary: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'summary')",
            [],
            |row| row.get(0),
        )?;
        if !has_summary {
            connection.execute(
                "ALTER TABLE tasks ADD COLUMN summary TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn main_session_id(&self) -> Result<String> {
        let connection = self.connection.lock().expect("database mutex poisoned");
        if let Ok(value) = connection.query_row(
            "SELECT value FROM settings WHERE key = 'main_session_id'",
            [],
            |row| row.get::<_, String>(0),
        ) {
            return Ok(value);
        }
        let value = Uuid::new_v4().to_string();
        connection.execute(
            "INSERT INTO settings(key, value) VALUES('main_session_id', ?1)",
            [&value],
        )?;
        Ok(value)
    }

    fn load_tasks(&self) -> Result<Vec<TaskView>> {
        let connection = self.connection.lock().expect("database mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, title, objective, state, progress, progress_message, summary, output,
                    error, session_id, created_at, updated_at FROM tasks ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(TaskView {
                id: row.get(0)?,
                title: row.get(1)?,
                objective: row.get(2)?,
                state: TaskState::from_str(&row.get::<_, String>(3)?),
                progress: row.get::<_, i64>(4)? as u8,
                progress_message: row.get(5)?,
                summary: row.get(6)?,
                output: row.get(7)?,
                error: row.get(8)?,
                session_id: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn save_task(&self, task: &TaskView) -> Result<()> {
        let connection = self.connection.lock().expect("database mutex poisoned");
        connection.execute(
            "INSERT INTO tasks(id, title, objective, state, progress, progress_message, summary,
                               output, error, session_id, created_at, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET state=excluded.state, progress=excluded.progress,
               progress_message=excluded.progress_message, summary=excluded.summary,
               output=excluded.output, error=excluded.error, updated_at=excluded.updated_at",
            params![
                task.id,
                task.title,
                task.objective,
                task.state.as_str(),
                task.progress,
                task.progress_message,
                task.summary,
                task.output,
                task.error,
                task.session_id,
                task.created_at,
                task.updated_at,
            ],
        )?;
        Ok(())
    }

    fn load_messages(&self) -> Result<Vec<ChatMessage>> {
        let connection = self.connection.lock().expect("database mutex poisoned");
        let mut statement = connection
            .prepare("SELECT id, role, text, created_at FROM messages ORDER BY created_at ASC")?;
        let rows = statement.query_map([], |row| {
            Ok(ChatMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                text: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn save_message(&self, message: &ChatMessage) -> Result<()> {
        let connection = self.connection.lock().expect("database mutex poisoned");
        connection.execute(
            "INSERT OR IGNORE INTO messages(id, role, text, created_at) VALUES(?1, ?2, ?3, ?4)",
            params![message.id, message.role, message.text, message.created_at],
        )?;
        Ok(())
    }

    fn enqueue_notification(&self, notification: &TaskNotification) -> Result<bool> {
        let connection = self.connection.lock().expect("database mutex poisoned");
        let changed = connection.execute(
            "INSERT OR IGNORE INTO notification_outbox(event_id, task_id, payload)
             VALUES(?1, ?2, ?3)",
            params![
                notification.event_id,
                notification.task_id,
                serde_json::to_string(notification)?,
            ],
        )?;
        Ok(changed > 0)
    }

    fn pending_notifications(&self) -> Result<Vec<TaskNotification>> {
        let connection = self.connection.lock().expect("database mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT payload FROM notification_outbox
             WHERE state = 'pending'
               AND (last_attempt_epoch IS NULL OR last_attempt_epoch <= CAST(strftime('%s', 'now') AS INTEGER) - 30)
             ORDER BY rowid ASC LIMIT 20",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let payload = row?;
            serde_json::from_str(&payload).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    payload.len(),
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
    }

    fn mark_notification_attempt(&self, event_id: &str) -> Result<()> {
        let connection = self.connection.lock().expect("database mutex poisoned");
        connection.execute(
            "UPDATE notification_outbox
             SET attempts = attempts + 1, last_attempt_epoch = CAST(strftime('%s', 'now') AS INTEGER)
             WHERE event_id = ?1 AND state = 'pending'",
            [event_id],
        )?;
        Ok(())
    }

    fn ack_notification(&self, event_id: &str) -> Result<bool> {
        let connection = self.connection.lock().expect("database mutex poisoned");
        let changed = connection.execute(
            "UPDATE notification_outbox SET state = 'sent', sent_at = ?2
             WHERE event_id = ?1 AND state = 'pending'",
            params![event_id, now()],
        )?;
        Ok(changed > 0)
    }
}

struct ContextState {
    config: Config,
    state: RwLock<RuntimeState>,
    agents: RwLock<HashMap<String, AgentHandle>>,
    store: Store,
    events: broadcast::Sender<Value>,
}

type AppContext = Arc<ContextState>;

#[derive(Deserialize)]
struct Request {
    id: Option<String>,
    method: String,
    #[serde(default)]
    params: Value,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn compact_summary(value: &str, max_chars: usize) -> String {
    let normalized = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let summary = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{summary}…")
    } else {
        summary
    }
}

fn notification_for_task(task: &TaskView) -> TaskNotification {
    TaskNotification {
        event_id: format!("task.completed:{}", task.id),
        event_type: "task.completed".to_owned(),
        task_id: task.id.clone(),
        title: task.title.clone(),
        summary: task.summary.clone(),
        result_ref: format!("task://{}", task.id),
        created_at: now(),
    }
}

async fn snapshot(context: &AppContext) -> Snapshot {
    let state = context.state.read().await;
    let mut tasks = state.tasks.values().cloned().collect::<Vec<_>>();
    tasks.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Snapshot {
        seq: state.seq,
        main: state.main.clone(),
        tasks,
    }
}

async fn publish(context: &AppContext) {
    {
        let mut state = context.state.write().await;
        state.seq += 1;
    }
    let data = snapshot(context).await;
    let event = json!({
        "type": "event",
        "event": "snapshot.changed",
        "seq": data.seq,
        "data": data,
    });
    let _ = context.events.send(event);
}

fn extract_text(message: &Value) -> Option<String> {
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        return Some(text.to_owned());
    }
    let blocks = message.get("content")?.as_array()?;
    let text = blocks
        .iter()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

async fn add_main_message(context: &AppContext, role: &str, text: String) -> Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let message = ChatMessage {
        id: Uuid::new_v4().to_string(),
        role: role.to_owned(),
        text,
        created_at: now(),
    };
    context.store.save_message(&message)?;
    context.state.write().await.main.messages.push(message);
    Ok(())
}

async fn save_task_from_state(context: &AppContext, task_id: &str) -> Result<Option<TaskView>> {
    let task = context.state.read().await.tasks.get(task_id).cloned();
    if let Some(task) = &task {
        context.store.save_task(task)?;
    }
    Ok(task)
}

#[derive(Clone)]
enum AgentTarget {
    Main,
    Task(String),
}

impl AgentTarget {
    fn key(&self) -> String {
        match self {
            Self::Main => "main".to_owned(),
            Self::Task(id) => format!("task:{id}"),
        }
    }
}

async fn spawn_pi(
    context: AppContext,
    target: AgentTarget,
    session_id: String,
    initial_prompt: Option<String>,
) -> Result<()> {
    let key = target.key();
    if context.agents.read().await.contains_key(&key) {
        return Ok(());
    }

    let (role, system_prompt, tools, workspace) = match &target {
        AgentTarget::Main => (
            "main",
            context.config.main_prompt.clone(),
            "task_create,task_list,task_status,task_cancel",
            context.config.root.join("workspaces/main"),
        ),
        AgentTarget::Task(id) => (
            "worker",
            context.config.worker_prompt.clone(),
            "read,bash,edit,write,task_progress,task_complete",
            context.config.root.join("workspaces/tasks").join(id),
        ),
    };
    fs::create_dir_all(&workspace)?;
    let session_dir = context.config.root.join("sessions").join(role);
    fs::create_dir_all(&session_dir)?;

    let mut command = Command::new(&context.config.pi_bin);
    command
        .current_dir(&workspace)
        .arg("--mode")
        .arg("rpc")
        .arg("--offline")
        .arg("--session-id")
        .arg(&session_id)
        .arg("--session-dir")
        .arg(&session_dir)
        .arg("--name")
        .arg(match &target {
            AgentTarget::Main => "Pinvou Main".to_owned(),
            AgentTarget::Task(id) => format!("Task {}", &id[..8.min(id.len())]),
        })
        .arg("--system-prompt")
        .arg(system_prompt)
        .arg("--no-extensions")
        .arg("--extension")
        .arg(&context.config.extension)
        .arg("--no-skills")
        .arg("--no-prompt-templates")
        .arg("--no-themes")
        .arg("--no-context-files")
        .arg("--tools")
        .arg(tools)
        .arg("--approve")
        .env("PINVOU_AIOS_HOME", &context.config.root)
        .env("PINVOU_AIOS_SOCKET", &context.config.socket)
        .env("PINVOU_AGENT_ROLE", role)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let AgentTarget::Task(id) = &target {
        command.env("PINVOU_TASK_ID", id);
    }
    if let Some(provider) = &context.config.provider {
        command.arg("--provider").arg(provider);
    }
    if let Some(model) = &context.config.model {
        command.arg("--model").arg(model);
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to spawn Pi at {}", context.config.pi_bin.display()))?;
    let stdin = child.stdin.take().context("Pi stdin unavailable")?;
    let stdout = child.stdout.take().context("Pi stdout unavailable")?;
    let stderr = child.stderr.take().context("Pi stderr unavailable")?;
    let (tx, mut rx) = mpsc::channel::<Value>(64);

    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(command) = rx.recv().await {
            let mut line = match serde_json::to_vec(&command) {
                Ok(line) => line,
                Err(error) => {
                    warn!(%error, "failed to encode Pi RPC command");
                    continue;
                }
            };
            line.push(b'\n');
            if stdin.write_all(&line).await.is_err() {
                break;
            }
        }
    });

    let read_context = context.clone();
    let read_target = target.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    match serde_json::from_str::<Value>(line.trim_end_matches('\r')) {
                        Ok(event) => handle_pi_event(&read_context, &read_target, event).await,
                        Err(error) => warn!(%error, line, "invalid Pi RPC output"),
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    warn!(%error, "failed reading Pi RPC output");
                    break;
                }
            }
        }
    });

    let stderr_key = key.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            warn!(agent = %stderr_key, %line, "Pi stderr");
        }
    });

    let wait_context = context.clone();
    let wait_target = target.clone();
    let wait_key = key.clone();
    tokio::spawn(async move {
        let status = child.wait().await;
        wait_context.agents.write().await.remove(&wait_key);
        let reason = match status {
            Ok(status) => format!("Pi exited with {status}"),
            Err(error) => format!("Pi wait failed: {error}"),
        };
        match &wait_target {
            AgentTarget::Main => {
                let mut state = wait_context.state.write().await;
                state.main.status = "offline".to_owned();
                state.main.error = Some(reason);
            }
            AgentTarget::Task(id) => {
                let mut state = wait_context.state.write().await;
                if let Some(task) = state.tasks.get_mut(id) {
                    if task.state.active() {
                        task.state = TaskState::Failed;
                        task.error = Some(reason);
                        task.updated_at = now();
                    }
                }
            }
        }
        if let AgentTarget::Task(id) = &wait_target {
            let _ = save_task_from_state(&wait_context, id).await;
        }
        publish(&wait_context).await;
    });

    context
        .agents
        .write()
        .await
        .insert(key, AgentHandle { tx: tx.clone() });
    tx.send(json!({ "id": "bootstrap-state", "type": "get_state" }))
        .await?;
    if matches!(target, AgentTarget::Main) {
        tx.send(json!({ "id": "bootstrap-messages", "type": "get_messages" }))
            .await?;
    }
    if let Some(message) = initial_prompt {
        tx.send(json!({ "id": "initial-prompt", "type": "prompt", "message": message }))
            .await?;
    }
    Ok(())
}

async fn handle_pi_event(context: &AppContext, target: &AgentTarget, event: Value) {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if event_type == "response"
        && event.get("command").and_then(Value::as_str) == Some("get_state")
        && matches!(target, AgentTarget::Main)
    {
        let model_id = event.pointer("/data/model/id").and_then(Value::as_str);
        let mut state = context.state.write().await;
        if matches!(model_id, None | Some("unknown")) {
            state.main.status = "needs_setup".to_owned();
            state.main.error = Some(
                "Pi 尚未选中可用模型。请配置 Pi 认证，或设置 PINVOU_PI_PROVIDER 与 PINVOU_PI_MODEL 后重启守护进程。"
                    .to_owned(),
            );
        } else {
            state.main.status = "idle".to_owned();
            state.main.error = None;
        }
        drop(state);
        publish(context).await;
        return;
    }

    if event_type == "response" && event.get("success").and_then(Value::as_bool) == Some(false) {
        let reason = event
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Pi RPC command failed")
            .to_owned();
        match target {
            AgentTarget::Main => {
                let mut state = context.state.write().await;
                state.main.status = "idle".to_owned();
                state.main.error = Some(reason);
            }
            AgentTarget::Task(id) => {
                let mut state = context.state.write().await;
                if let Some(task) = state.tasks.get_mut(id) {
                    task.state = TaskState::Failed;
                    task.progress_message = "Pi 未能接受任务".to_owned();
                    task.error = Some(reason);
                    task.updated_at = now();
                }
                drop(state);
                let _ = save_task_from_state(context, id).await;
            }
        }
        publish(context).await;
        return;
    }

    if event_type == "response"
        && event.get("command").and_then(Value::as_str) == Some("get_messages")
        && matches!(target, AgentTarget::Main)
    {
        if let Some(messages) = event.pointer("/data/messages").and_then(Value::as_array) {
            for message in messages {
                if let (Some(role @ ("user" | "assistant")), Some(text)) =
                    (message_role(message), extract_text(message))
                {
                    let duplicate = context
                        .state
                        .read()
                        .await
                        .main
                        .messages
                        .iter()
                        .any(|known| known.role == role && known.text == text);
                    if !duplicate {
                        let _ = add_main_message(context, role, text).await;
                    }
                }
            }
        }
        publish(context).await;
        return;
    }

    match target {
        AgentTarget::Main => match event_type {
            "agent_start" => {
                let mut state = context.state.write().await;
                state.main.status = "thinking".to_owned();
                state.main.error = None;
            }
            "message_start" => {
                if event.pointer("/message/role").and_then(Value::as_str) == Some("assistant") {
                    context.state.write().await.main.streaming_text.clear();
                }
            }
            "message_update" => {
                if event
                    .pointer("/assistantMessageEvent/type")
                    .and_then(Value::as_str)
                    == Some("text_delta")
                {
                    if let Some(delta) = event
                        .pointer("/assistantMessageEvent/delta")
                        .and_then(Value::as_str)
                    {
                        context
                            .state
                            .write()
                            .await
                            .main
                            .streaming_text
                            .push_str(delta);
                    }
                    // The Tauri shell polls the live snapshot. Avoid broadcasting a full
                    // snapshot for every model token; message_end publishes the final state.
                    return;
                }
            }
            "message_end" => {
                if let Some(message) = event.get("message") {
                    if message_role(message) == Some("assistant") {
                        if let Some(text) = extract_text(message) {
                            let _ = add_main_message(context, "assistant", text).await;
                        }
                        context.state.write().await.main.streaming_text.clear();
                    }
                }
            }
            "agent_settled" => context.state.write().await.main.status = "idle".to_owned(),
            "extension_error" => {
                context.state.write().await.main.error = Some(event.to_string());
            }
            _ => return,
        },
        AgentTarget::Task(id) => {
            let mut should_save = false;
            let mut completed_task = None;
            {
                let mut state = context.state.write().await;
                if let Some(task) = state.tasks.get_mut(id) {
                    match event_type {
                        "agent_start" => {
                            task.state = TaskState::Running;
                            task.progress_message = "后台 Agent 正在执行".to_owned();
                            task.updated_at = now();
                            should_save = true;
                        }
                        "message_update" => {
                            let update_type = event
                                .pointer("/assistantMessageEvent/type")
                                .and_then(Value::as_str);
                            match update_type {
                                Some("thinking_start") if task.state.active() => {
                                    task.progress = task.progress.max(10);
                                    task.progress_message = "DeepSeek 正在推理".to_owned();
                                    task.updated_at = now();
                                    should_save = true;
                                }
                                Some("thinking_delta") => return,
                                Some("text_start") if task.state.active() => {
                                    task.output.clear();
                                    task.progress = task.progress.max(55);
                                    task.progress_message = "正在生成任务结果".to_owned();
                                    task.updated_at = now();
                                    should_save = true;
                                }
                                Some("text_delta") if task.state.active() => {
                                    if let Some(delta) = event
                                        .pointer("/assistantMessageEvent/delta")
                                        .and_then(Value::as_str)
                                    {
                                        task.output.push_str(delta);
                                    }
                                    // The UI polls this in-memory buffer; publish once at
                                    // phase boundaries instead of once per token.
                                    return;
                                }
                                _ => return,
                            }
                        }
                        "message_end" => {
                            let message = event.get("message");
                            if message.and_then(message_role) == Some("assistant")
                                && let Some(text) = message.and_then(extract_text)
                            {
                                if task.state.active() || task.output.is_empty() {
                                    task.output = text;
                                    task.updated_at = now();
                                    should_save = true;
                                }
                            }
                        }
                        "agent_settled" if task.state.active() => {
                            task.state = TaskState::Completed;
                            task.progress = 100;
                            task.progress_message = "已完成".to_owned();
                            if task.summary.is_empty() {
                                task.summary =
                                    format!("“{}”已完成，完整结果可在任务卡片中查看。", task.title);
                            }
                            task.updated_at = now();
                            should_save = true;
                            completed_task = Some(task.clone());
                        }
                        _ => return,
                    }
                }
            }
            if should_save {
                let _ = save_task_from_state(context, id).await;
            }
            if let Some(task) = completed_task
                && let Err(error) = enqueue_and_deliver_notification(context, &task).await
            {
                warn!(%error, task_id = %task.id, "failed to enqueue task notification");
            }
        }
    }
    publish(context).await;
}

async fn send_agent(context: &AppContext, key: &str, command: Value) -> Result<()> {
    let handle = context
        .agents
        .read()
        .await
        .get(key)
        .cloned()
        .ok_or_else(|| anyhow!("agent {key} is not running"))?;
    handle
        .tx
        .send(command)
        .await
        .context("agent command channel closed")
}

async fn deliver_notification(context: &AppContext, notification: &TaskNotification) -> Result<()> {
    context
        .store
        .mark_notification_attempt(&notification.event_id)?;
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(notification)?);
    send_agent(
        context,
        "main",
        json!({
            "id": format!("notification:{}", notification.event_id),
            "type": "prompt",
            "message": format!("/aios-task-event {payload}")
        }),
    )
    .await
}

async fn enqueue_and_deliver_notification(context: &AppContext, task: &TaskView) -> Result<()> {
    let notification = notification_for_task(task);
    if context.store.enqueue_notification(&notification)? {
        deliver_notification(context, &notification).await?;
    }
    Ok(())
}

async fn deliver_pending_notifications(context: &AppContext) {
    let notifications = match context.store.pending_notifications() {
        Ok(notifications) => notifications,
        Err(error) => {
            warn!(%error, "failed to load pending task notifications");
            return;
        }
    };
    for notification in notifications {
        if let Err(error) = deliver_notification(context, &notification).await {
            warn!(
                %error,
                event_id = %notification.event_id,
                "failed to deliver task notification"
            );
        }
    }
}

fn required_string(params: &Value, name: &str) -> Result<String> {
    let value = params
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("missing parameter: {name}"))?;
    Ok(value.to_owned())
}

async fn dispatch(context: &AppContext, request: &Request) -> Result<Value> {
    match request.method.as_str() {
        "snapshot.get" => Ok(serde_json::to_value(snapshot(context).await)?),
        "main.prompt" => {
            let message = required_string(&request.params, "message")?;
            add_main_message(context, "user", message.clone()).await?;
            publish(context).await;
            send_agent(
                context,
                "main",
                json!({
                    "id": format!("main-prompt:{}", Uuid::new_v4()),
                    "type": "prompt",
                    "message": message,
                    "streamingBehavior": "followUp"
                }),
            )
            .await?;
            Ok(json!({ "accepted": true }))
        }
        "task.create" => {
            let title = required_string(&request.params, "title")?;
            let objective = required_string(&request.params, "objective")?;
            let id = Uuid::new_v4().to_string();
            let timestamp = now();
            let task = TaskView {
                id: id.clone(),
                title,
                objective: objective.clone(),
                state: TaskState::Queued,
                progress: 0,
                progress_message: "正在启动后台 Agent".to_owned(),
                summary: String::new(),
                output: String::new(),
                error: None,
                session_id: Uuid::new_v4().to_string(),
                created_at: timestamp.clone(),
                updated_at: timestamp,
            };
            context.store.save_task(&task)?;
            context
                .state
                .write()
                .await
                .tasks
                .insert(id.clone(), task.clone());
            publish(context).await;
            let prompt = format!(
                "这是你的唯一任务。\n\n标题：{}\n\n目标与交付要求：\n{}",
                task.title, task.objective
            );
            if let Err(error) = spawn_pi(
                context.clone(),
                AgentTarget::Task(id.clone()),
                task.session_id.clone(),
                Some(prompt),
            )
            .await
            {
                let mut state = context.state.write().await;
                if let Some(task) = state.tasks.get_mut(&id) {
                    task.state = TaskState::Failed;
                    task.error = Some(error.to_string());
                    task.updated_at = now();
                }
                drop(state);
                save_task_from_state(context, &id).await?;
                publish(context).await;
                return Err(error);
            }
            Ok(serde_json::to_value(task)?)
        }
        "task.list" => Ok(serde_json::to_value(snapshot(context).await.tasks)?),
        "task.status" => {
            let id = required_string(&request.params, "taskId")?;
            let state = context.state.read().await;
            Ok(serde_json::to_value(
                state
                    .tasks
                    .get(&id)
                    .ok_or_else(|| anyhow!("task not found: {id}"))?,
            )?)
        }
        "task.progress" => {
            let id = required_string(&request.params, "taskId")?;
            let message = required_string(&request.params, "message")?;
            let percent = request
                .params
                .get("percent")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(99) as u8;
            {
                let mut state = context.state.write().await;
                let task = state
                    .tasks
                    .get_mut(&id)
                    .ok_or_else(|| anyhow!("task not found: {id}"))?;
                if !task.state.active() {
                    bail!("task is no longer active");
                }
                task.state = TaskState::Running;
                task.progress = percent;
                task.progress_message = message;
                task.updated_at = now();
            }
            let task = save_task_from_state(context, &id)
                .await?
                .context("task disappeared")?;
            publish(context).await;
            Ok(serde_json::to_value(task)?)
        }
        "task.complete" => {
            let id = required_string(&request.params, "taskId")?;
            let result = required_string(&request.params, "result")?;
            let requested_summary = request
                .params
                .get("summary")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| compact_summary(value, 280));
            {
                let mut state = context.state.write().await;
                let task = state
                    .tasks
                    .get_mut(&id)
                    .ok_or_else(|| anyhow!("task not found: {id}"))?;
                if matches!(task.state, TaskState::Cancelled) {
                    bail!("task was cancelled");
                }
                task.state = TaskState::Completed;
                task.progress = 100;
                task.progress_message = "已完成".to_owned();
                task.summary = requested_summary.unwrap_or_else(|| {
                    format!("“{}”已完成，完整结果可在任务卡片中查看。", task.title)
                });
                task.output = result;
                task.updated_at = now();
            }
            let task = save_task_from_state(context, &id)
                .await?
                .context("task disappeared")?;
            publish(context).await;
            if let Err(error) = enqueue_and_deliver_notification(context, &task).await {
                warn!(%error, task_id = %task.id, "failed to enqueue task notification");
            }
            Ok(serde_json::to_value(task)?)
        }
        "notification.ack" => {
            let event_id = required_string(&request.params, "eventId")?;
            Ok(json!({ "acknowledged": context.store.ack_notification(&event_id)? }))
        }
        "task.cancel" => {
            let id = required_string(&request.params, "taskId")?;
            let _ = send_agent(context, &format!("task:{id}"), json!({ "type": "abort" })).await;
            {
                let mut state = context.state.write().await;
                let task = state
                    .tasks
                    .get_mut(&id)
                    .ok_or_else(|| anyhow!("task not found: {id}"))?;
                task.state = TaskState::Cancelled;
                task.progress_message = "已取消".to_owned();
                task.updated_at = now();
            }
            let task = save_task_from_state(context, &id)
                .await?
                .context("task disappeared")?;
            publish(context).await;
            Ok(serde_json::to_value(task)?)
        }
        method => bail!("unknown method: {method}"),
    }
}

async fn handle_client(context: AppContext, stream: UnixStream) -> Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();
    let mut events = context.events.subscribe();
    let (responses_tx, mut responses_rx) = mpsc::channel::<Value>(32);

    let request_context = context.clone();
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            let response = match serde_json::from_str::<Request>(line.trim_end_matches('\r')) {
                Ok(request) => {
                    let id = request.id.clone();
                    match dispatch(&request_context, &request).await {
                        Ok(result) => json!({ "id": id, "ok": true, "result": result }),
                        Err(error) => json!({ "id": id, "ok": false, "error": error.to_string() }),
                    }
                }
                Err(error) => {
                    json!({ "id": null, "ok": false, "error": format!("invalid request: {error}") })
                }
            };
            if responses_tx.send(response).await.is_err() {
                break;
            }
        }
    });

    loop {
        let message = tokio::select! {
            response = responses_rx.recv() => match response {
                Some(response) => response,
                None => break,
            },
            event = events.recv() => match event {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => json!({
                    "type": "event",
                    "event": "snapshot.changed",
                    "data": snapshot(&context).await,
                }),
                Err(broadcast::error::RecvError::Closed) => break,
            }
        };
        let mut encoded = serde_json::to_vec(&message)?;
        encoded.push(b'\n');
        if write_half.write_all(&encoded).await.is_err() {
            break;
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("pinvou_aiosd=info".parse()?),
        )
        .init();

    let config = Config::load()?;
    if !config.pi_bin.exists() {
        bail!("Pi launcher not found at {}", config.pi_bin.display());
    }
    fs::create_dir_all(config.root.join("run"))?;
    fs::create_dir_all(config.root.join("sessions/main"))?;
    fs::create_dir_all(config.root.join("sessions/worker"))?;
    if config.socket.exists() {
        fs::remove_file(&config.socket).with_context(|| {
            format!("failed to remove stale socket {}", config.socket.display())
        })?;
    }

    let store = Store::open(&config.root.join("state.sqlite3"))?;
    let main_session_id = store.main_session_id()?;
    let messages = store.load_messages()?;
    let mut tasks = HashMap::new();
    for mut task in store.load_tasks()? {
        if task.state.active() {
            task.state = TaskState::Interrupted;
            task.progress_message = "守护进程重启后已中断，可重新创建任务".to_owned();
            task.updated_at = now();
            store.save_task(&task)?;
        }
        tasks.insert(task.id.clone(), task);
    }
    let (events, _) = broadcast::channel(256);
    let context = Arc::new(ContextState {
        config: config.clone(),
        state: RwLock::new(RuntimeState {
            seq: 0,
            main: MainAgentView {
                session_id: main_session_id.clone(),
                status: "starting".to_owned(),
                streaming_text: String::new(),
                error: None,
                messages,
            },
            tasks,
        }),
        agents: RwLock::new(HashMap::new()),
        store,
        events,
    });

    if let Err(error) = spawn_pi(context.clone(), AgentTarget::Main, main_session_id, None).await {
        error!(%error, "main Pi agent failed to start");
        let mut state = context.state.write().await;
        state.main.status = "offline".to_owned();
        state.main.error = Some(error.to_string());
    }

    let listener = UnixListener::bind(&config.socket)
        .with_context(|| format!("failed to bind {}", config.socket.display()))?;
    info!(socket = %config.socket.display(), pi = %config.pi_bin.display(), "Pinvou AIOS daemon ready");

    let notification_context = context.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            interval.tick().await;
            deliver_pending_notifications(&notification_context).await;
        }
    });

    loop {
        let (stream, _) = listener.accept().await?;
        let client_context = context.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_client(client_context, stream).await {
                warn!(%error, "AIOS client disconnected with error");
            }
        });
    }
}
