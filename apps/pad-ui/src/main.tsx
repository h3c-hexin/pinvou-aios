import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  Check,
  ChevronRight,
  CircleStop,
  Command,
  Layers3,
  MessageCircleMore,
  Mic,
  Plus,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import "./styles.css";

type TaskState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

interface Task {
  id: string;
  title: string;
  objective: string;
  state: TaskState;
  progress: number;
  progressMessage: string;
  output: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface Snapshot {
  seq: number;
  main: {
    sessionId: string;
    status: string;
    streamingText: string;
    error?: string;
    messages: ChatMessage[];
  };
  tasks: Task[];
}

const emptySnapshot: Snapshot = {
  seq: 0,
  main: { sessionId: "", status: "connecting", streamingText: "", messages: [] },
  tasks: [],
};

async function daemonRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>("daemon_request", { method, params });
}

function statusLabel(state: TaskState) {
  return {
    queued: "排队中",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
  }[state];
}

function TaskCard({ task, onOpen, onCancel }: { task: Task; onOpen: () => void; onCancel: () => void }) {
  const active = task.state === "running" || task.state === "queued";
  return (
    <article className="task-card" onClick={onOpen}>
      <div className="task-card__top">
        <span className={`status-dot status-dot--${task.state}`} />
        <span className="task-state">{statusLabel(task.state)}</span>
        {active && (
          <button
            className="icon-button icon-button--tiny"
            title="取消任务"
            onClick={(event) => {
              event.stopPropagation();
              onCancel();
            }}
          >
            <CircleStop size={14} />
          </button>
        )}
      </div>
      <h3>{task.title}</h3>
      <p>{task.progressMessage || task.objective}</p>
      {active && (
        <div className="progress-track">
          <span style={{ width: `${Math.max(task.progress, 4)}%` }} />
        </div>
      )}
      <div className="task-card__footer">
        <span>{active ? `${task.progress}%` : new Date(task.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
        <ChevronRight size={14} />
      </div>
    </article>
  );
}

function App() {
  const [snapshot, setSnapshot] = React.useState(emptySnapshot);
  const [input, setInput] = React.useState("");
  const [error, setError] = React.useState<string>();
  const [sending, setSending] = React.useState(false);
  const [selectedTask, setSelectedTask] = React.useState<Task>();
  const [manualTask, setManualTask] = React.useState(false);
  const [completedNotice, setCompletedNotice] = React.useState<Task>();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const observedTaskStates = React.useRef<Map<string, TaskState>>(new Map());
  const taskStateHydrated = React.useRef(false);

  const refresh = React.useCallback(async () => {
    try {
      const next = await daemonRequest<Snapshot>("snapshot.get");
      if (taskStateHydrated.current) {
        const completed = next.tasks.find(
          (task) =>
            task.state === "completed" &&
            ["queued", "running"].includes(observedTaskStates.current.get(task.id) ?? ""),
        );
        if (completed) setCompletedNotice(completed);
      } else {
        taskStateHydrated.current = true;
      }
      observedTaskStates.current = new Map(next.tasks.map((task) => [task.id, task.state]));
      setSnapshot(next);
      setError(undefined);
      if (selectedTask) {
        setSelectedTask(next.tasks.find((task) => task.id === selectedTask.id));
      }
    } catch (reason) {
      setError(String(reason));
    }
  }, [selectedTask?.id]);

  React.useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 600);
    return () => window.clearInterval(timer);
  }, [refresh]);

  React.useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const frame = window.requestAnimationFrame(() => {
      // Streaming updates arrive several times a second. A smooth animation gets
      // restarted before reaching the bottom, so keep the viewport pinned directly.
      container.scrollTop = container.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [snapshot.main.messages.length, snapshot.main.streamingText]);

  React.useEffect(() => {
    if (!completedNotice) return;
    const timer = window.setTimeout(() => setCompletedNotice(undefined), 7000);
    return () => window.clearTimeout(timer);
  }, [completedNotice?.id]);

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || sending) return;
    setInput("");
    setSending(true);
    try {
      await daemonRequest("main.prompt", { message });
      await refresh();
    } catch (reason) {
      setError(String(reason));
      setInput(message);
    } finally {
      setSending(false);
    }
  }

  async function createTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await daemonRequest("task.create", {
        title: form.get("title"),
        objective: form.get("objective"),
      });
      setManualTask(false);
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function cancelTask(task: Task) {
    try {
      await daemonRequest("task.cancel", { taskId: task.id });
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }

  const running = snapshot.tasks.filter((task) => task.state === "running" || task.state === "queued");
  const recent = snapshot.tasks.filter((task) => !running.includes(task)).slice(0, 4);
  const messages = snapshot.main.messages;
  const mainNeedsSetup = snapshot.main.status === "needs_setup" || snapshot.main.status === "offline";

  return (
    <main className="shell">
      <div className="aurora aurora--one" />
      <div className="aurora aurora--two" />

      <nav className="rail glass-panel">
        <div className="brand-mark"><Sparkles size={22} /></div>
        <button className="nav-button nav-button--active" title="对话"><MessageCircleMore size={21} /></button>
        <button className="nav-button" title="任务"><Layers3 size={21} /></button>
        <div className="rail-spacer" />
          <div className={`agent-orb agent-orb--${mainNeedsSetup ? "offline" : snapshot.main.status}`} title={`主 Agent：${snapshot.main.status}`}>
          <Bot size={19} />
        </div>
      </nav>

      <section className="conversation">
        <header className="topbar">
          <div>
            <span className="eyebrow">PINVOU AIOS</span>
            <h1>你的 AI 工作空间</h1>
          </div>
          <div className="runtime-pill">
            <span className={`status-dot status-dot--${mainNeedsSetup ? "failed" : "running"}`} />
            Pi · {snapshot.main.status === "thinking" ? "思考中" : snapshot.main.status === "needs_setup" ? "待配置模型" : snapshot.main.status === "offline" ? "离线" : "就绪"}
          </div>
        </header>

        <div className="message-stream" ref={scrollRef}>
          {messages.length === 0 && !snapshot.main.streamingText ? (
            <div className="welcome-card glass-panel">
              <div className="welcome-icon"><Command size={28} /></div>
              <p className="eyebrow">ALWAYS READY</p>
              <h2>现在想做点什么？</h2>
              <p>你只需要对话。复杂工作会进入独立后台进程，主对话始终可以继续。</p>
              <div className="suggestions">
                <button onClick={() => setInput("帮我整理一份本周工作汇报")}>整理工作汇报</button>
                <button onClick={() => setInput("研究一个主题并给我结论")}>研究并总结</button>
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={`message message--${message.role}`}>
                <div className="message__label">{message.role === "user" ? "你" : "Pinvou"}</div>
                <div className="message__bubble">{message.text}</div>
              </div>
            ))
          )}
          {snapshot.main.streamingText && (
            <div className="message message--assistant">
              <div className="message__label">Pinvou</div>
              <div className="message__bubble message__bubble--streaming">{snapshot.main.streamingText}<span className="cursor" /></div>
            </div>
          )}
        </div>

        <form className="composer glass-panel" onSubmit={sendMessage}>
          <button className="icon-button" type="button" title="语音入口将在下一阶段接入"><Mic size={20} /></button>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="和 Pinvou 说点什么…"
            rows={1}
          />
          <button className="send-button" type="submit" disabled={!input.trim() || sending}>
            <Send size={18} />
          </button>
        </form>
        {error && <div className="error-banner">{error}</div>}
      </section>

      <aside className="task-dock glass-panel">
        <div className="dock-header">
          <div>
            <span className="eyebrow">BACKGROUND</span>
            <h2>任务进程</h2>
          </div>
          <button className="icon-button" title="手动创建任务" onClick={() => setManualTask(true)}><Plus size={19} /></button>
        </div>

        <div className="dock-section">
          <div className="section-title"><span>进行中</span><b>{running.length}</b></div>
          {running.length ? running.map((task) => (
            <TaskCard key={task.id} task={task} onOpen={() => setSelectedTask(task)} onCancel={() => void cancelTask(task)} />
          )) : <div className="empty-state">没有正在运行的后台进程</div>}
        </div>

        {recent.length > 0 && (
          <div className="dock-section dock-section--recent">
            <div className="section-title"><span>最近完成</span></div>
            {recent.map((task) => (
              <TaskCard key={task.id} task={task} onOpen={() => setSelectedTask(task)} onCancel={() => void cancelTask(task)} />
            ))}
          </div>
        )}
      </aside>

      {selectedTask && (
        <div className="modal-backdrop" onClick={() => setSelectedTask(undefined)}>
          <section className="task-modal glass-panel" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close icon-button" onClick={() => setSelectedTask(undefined)}><X size={19} /></button>
            <span className="eyebrow">TASK PROCESS</span>
            <h2>{selectedTask.title}</h2>
            <div className="modal-status"><span className={`status-dot status-dot--${selectedTask.state}`} />{statusLabel(selectedTask.state)}</div>
            <h3>任务目标</h3>
            <p>{selectedTask.objective}</p>
            <h3>{selectedTask.state === "completed" ? "执行结果" : "实时输出"}</h3>
            <div className="result-box">{selectedTask.output || selectedTask.error || selectedTask.progressMessage}</div>
            {selectedTask.state === "completed" && <div className="complete-mark"><Check size={16} /> 后台进程已完成</div>}
          </section>
        </div>
      )}

      {manualTask && (
        <div className="modal-backdrop" onClick={() => setManualTask(false)}>
          <form className="task-modal glass-panel" onSubmit={createTask} onClick={(event) => event.stopPropagation()}>
            <button type="button" className="modal-close icon-button" onClick={() => setManualTask(false)}><X size={19} /></button>
            <span className="eyebrow">NEW PROCESS</span>
            <h2>创建后台任务</h2>
            <label>任务标题<input name="title" required placeholder="例如：整理季度汇报" /></label>
            <label>目标与交付要求<textarea name="objective" required rows={6} placeholder="告诉 Worker 需要做什么、有哪些背景、最终交付什么" /></label>
            <button className="primary-button" type="submit">启动 Agent 进程</button>
          </form>
        </div>
      )}

      {completedNotice && (
        <button
          className="completion-toast glass-panel"
          onClick={() => {
            setSelectedTask(completedNotice);
            setCompletedNotice(undefined);
          }}
        >
          <span className="completion-toast__icon"><Check size={17} /></span>
          <span><b>后台任务已完成</b><small>{completedNotice.title}</small></span>
          <ChevronRight size={17} />
        </button>
      )}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
