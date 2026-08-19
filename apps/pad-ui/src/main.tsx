import React from "react";
import ReactDOM from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  CircleStop,
  Command,
  ExternalLink,
  Globe2,
  Mic,
  MousePointer2,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Undo2,
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

interface BrowserState {
  ready: boolean;
  open: boolean;
  visible: boolean;
  loading: boolean;
  location: string;
  title?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  cdpEndpoint?: string;
  reason?: string;
  error?: string;
  editable?: boolean;
  editMode?: boolean;
  taskId?: string;
  selection?: SurfaceSelection;
}

interface SurfaceSelection {
  taskId?: string;
  selector: string;
  nodeId?: string;
  tagName: string;
  text: string;
  outerHTML: string;
  attributes: Record<string, string>;
  breadcrumbs: string[];
  rect: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
}

const emptySnapshot: Snapshot = {
  seq: 0,
  main: { sessionId: "", status: "connecting", streamingText: "", messages: [] },
  tasks: [],
};

function isBrowserPlaceholder(location?: string) {
  return !location || location === "about:blank" || location.startsWith("about:blank#pinvou-browser-surface");
}

function htmlArtifactLocation(task: Task) {
  if (task.state !== "completed") return undefined;
  const match = task.output.match(/(?:^|\n)HTML_ARTIFACT:\s*([^\r\n]+)/i);
  return match?.[1].trim();
}

async function daemonRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return window.pinvou.daemonRequest<T>(method, params);
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

function TaskChip({ task, onOpen, onCancel }: { task: Task; onOpen: () => void; onCancel: () => void }) {
  const active = task.state === "running" || task.state === "queued";
  const hasHtmlArtifact = Boolean(htmlArtifactLocation(task));
  return (
    <article className="task-chip" onClick={onOpen}>
      <div className="task-chip__top">
        <span className={`status-dot status-dot--${task.state}`} />
        <span className="task-chip__title">{task.title}</span>
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
      <div className="task-chip__meta">
        <span>{hasHtmlArtifact ? "HTML 画布" : statusLabel(task.state)}</span>
        <span>{hasHtmlArtifact ? "点击打开" : active ? `${task.progress}%` : new Date(task.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      {active && (
        <div className="progress-track">
          <span style={{ width: `${Math.max(task.progress, 4)}%` }} />
        </div>
      )}
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
  const [browserLocation, setBrowserLocation] = React.useState("https://example.com");
  const [browserState, setBrowserState] = React.useState<BrowserState>({
    ready: false,
    open: false,
    visible: false,
    loading: false,
    location: "about:blank",
  });
  const [browserBusy, setBrowserBusy] = React.useState(false);
  const [browserError, setBrowserError] = React.useState<string>();
  const [surfaceSelection, setSurfaceSelection] = React.useState<SurfaceSelection>();
  const [surfaceInstruction, setSurfaceInstruction] = React.useState("");
  const [surfaceBusy, setSurfaceBusy] = React.useState(false);
  const [surfaceFeedback, setSurfaceFeedback] = React.useState<string>();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const browserViewportRef = React.useRef<HTMLDivElement>(null);
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

  React.useEffect(() => {
    void window.pinvou.browserStatus()
      .then((state) => {
        setBrowserState(state);
        setSurfaceSelection(state.selection);
        if (!isBrowserPlaceholder(state.location)) setBrowserLocation(state.location);
      })
      .catch((reason) => setBrowserError(String(reason)));
    return window.pinvou.onBrowserState((state) => {
      setBrowserState(state);
      if (state.error) setBrowserError(state.error);
      if (state.selection) setSurfaceSelection(state.selection);
      else if (!state.editMode || !state.editable) setSurfaceSelection(undefined);
      if (!isBrowserPlaceholder(state.location)) {
        setBrowserLocation(state.location);
      }
    });
  }, []);

  React.useEffect(() => window.pinvou.onSurfaceSelection((selection) => {
    setSurfaceSelection(selection);
  }), []);

  React.useLayoutEffect(() => {
    const viewport = browserViewportRef.current;
    const shouldShow = browserState.open && !selectedTask && !manualTask;
    if (!viewport || !shouldShow) {
      void window.pinvou.browserSetBounds({ visible: false });
      return;
    }

    const syncBounds = () => {
      const rect = viewport.getBoundingClientRect();
      void window.pinvou.browserSetBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        visible: true,
      });
    };
    const frame = window.requestAnimationFrame(syncBounds);
    const observer = new ResizeObserver(syncBounds);
    observer.observe(viewport);
    window.addEventListener("resize", syncBounds);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      void window.pinvou.browserSetBounds({ visible: false });
    };
  }, [browserState.open, selectedTask, manualTask]);

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

  async function openTask(task: Task) {
    const artifact = htmlArtifactLocation(task);
    if (!artifact) {
      setSelectedTask(task);
      return;
    }

    setBrowserBusy(true);
    setBrowserError(undefined);
    try {
      const state = await window.pinvou.browserOpenTaskArtifact(task.id, artifact);
      setBrowserState(state);
      setBrowserLocation(state.location);
      setSelectedTask(undefined);
    } catch (reason) {
      setBrowserError(String(reason));
    } finally {
      setBrowserBusy(false);
    }
  }

  async function openBrowser(event?: React.FormEvent) {
    event?.preventDefault();
    const location = browserLocation.trim();
    if (!location || browserBusy) return;
    setBrowserBusy(true);
    setBrowserError(undefined);
    try {
      const state = await window.pinvou.browserOpen(location);
      setBrowserState(state);
    } catch (reason) {
      setBrowserError(String(reason));
    } finally {
      setBrowserBusy(false);
    }
  }

  async function controlBrowser(action: "back" | "forward" | "reload" | "close") {
    setBrowserError(undefined);
    try {
      const state = await window.pinvou.browserControl(action);
      setBrowserState(state);
    } catch (reason) {
      setBrowserError(String(reason));
    }
  }

  async function toggleSurfaceEdit() {
    setBrowserError(undefined);
    setSurfaceFeedback(undefined);
    try {
      const state = await window.pinvou.surfaceSetEditMode(!browserState.editMode);
      setBrowserState(state);
      if (!state.editMode) {
        setSurfaceSelection(undefined);
        setSurfaceInstruction("");
      }
    } catch (reason) {
      setBrowserError(String(reason));
    }
  }

  async function submitSurfaceEdit(event: React.FormEvent) {
    event.preventDefault();
    const instruction = surfaceInstruction.trim();
    if (!instruction || !surfaceSelection || surfaceBusy) return;
    setSurfaceBusy(true);
    setBrowserError(undefined);
    setSurfaceFeedback(undefined);
    try {
      await window.pinvou.surfaceModify(instruction);
      setSurfaceInstruction("");
      setSurfaceFeedback("已交给原任务 Agent，完成后画布会自动刷新");
      await refresh();
    } catch (reason) {
      setBrowserError(String(reason));
    } finally {
      setSurfaceBusy(false);
    }
  }

  async function undoSurfaceEdit() {
    if (surfaceBusy) return;
    setSurfaceBusy(true);
    setBrowserError(undefined);
    setSurfaceFeedback(undefined);
    try {
      await window.pinvou.surfaceUndo();
      setSurfaceFeedback("已恢复到上一个 HTML 版本");
      await refresh();
    } catch (reason) {
      setBrowserError(String(reason));
    } finally {
      setSurfaceBusy(false);
    }
  }

  const running = snapshot.tasks.filter((task) => task.state === "running" || task.state === "queued");
  const orderedTasks = [
    ...running,
    ...snapshot.tasks.filter((task) => task.state !== "running" && task.state !== "queued"),
  ];
  const messages = snapshot.main.messages;
  const mainNeedsSetup = snapshot.main.status === "needs_setup" || snapshot.main.status === "offline";
  const surfaceTask = snapshot.tasks.find((task) => task.id === browserState.taskId);
  const surfaceTaskActive = surfaceTask?.state === "queued" || surfaceTask?.state === "running";

  return (
    <main className="shell">
      <div className="aurora aurora--one" />
      <div className="aurora aurora--two" />

      <section className="conversation glass-panel">
        <header className="topbar topbar--agent">
          <div>
            <span className="eyebrow">PINVOU AIOS</span>
            <h1>主 Agent</h1>
          </div>
          <div className="runtime-pill">
            <span className={`status-dot status-dot--${mainNeedsSetup ? "failed" : "running"}`} />
            Pi · {snapshot.main.status === "thinking" ? "思考中" : snapshot.main.status === "needs_setup" ? "待配置模型" : snapshot.main.status === "offline" ? "离线" : "就绪"}
          </div>
        </header>

        <section className="process-strip" aria-label="任务进程状态">
          <div className="process-strip__header">
            <div>
              <span className="eyebrow">PROCESSES</span>
              <span className="process-summary">
                {running.length ? `${running.length} 个运行中` : "当前空闲"} · 共 {snapshot.tasks.length} 个
              </span>
            </div>
            <button className="icon-button icon-button--compact" title="手动创建任务" onClick={() => setManualTask(true)}><Plus size={16} /></button>
          </div>
          <div className="process-strip__list">
            {orderedTasks.length ? orderedTasks.map((task) => (
              <TaskChip key={task.id} task={task} onOpen={() => void openTask(task)} onCancel={() => void cancelTask(task)} />
            )) : <div className="process-empty"><span className="status-dot" />后台进程将在这里显示</div>}
          </div>
        </section>

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

      <section className="browser-workspace">
        <div className="browser-stage">
          <section className="browser-console glass-panel">
            <div className="browser-console__heading">
              <span className="browser-lights"><i /><i /><i /></span>
              <span className="browser-console__title">{browserState.title || "Pinvou Chromium"}</span>
              <span className="surface-badge">
                <span className={`status-dot status-dot--${browserState.open ? "running" : "queued"}`} />
                {browserState.loading ? "加载中" : browserState.open ? "Agent · Human" : "待打开"}
              </span>
            </div>
            <form className="browser-toolbar" onSubmit={openBrowser}>
              <button type="button" title="后退" disabled={!browserState.open} onClick={() => void controlBrowser("back")}><ArrowLeft size={17} /></button>
              <button type="button" title="前进" disabled={!browserState.open} onClick={() => void controlBrowser("forward")}><ArrowRight size={17} /></button>
              <button type="button" title="刷新" disabled={!browserState.open} onClick={() => void controlBrowser("reload")}><RefreshCw size={16} /></button>
              <button
                className={`surface-edit-toggle ${browserState.editMode ? "surface-edit-toggle--active" : ""}`}
                type="button"
                title={browserState.editable ? "点击页面元素并告诉 AI 如何修改" : "仅任务生成的本地 HTML 支持 AI 修改"}
                disabled={!browserState.editable}
                onClick={() => void toggleSurfaceEdit()}
              >
                <MousePointer2 size={15} /><span>AI 修改</span>
              </button>
              <div className="browser-address">
                <Globe2 size={15} />
                <input
                  value={browserLocation}
                  onChange={(event) => setBrowserLocation(event.target.value)}
                  placeholder="输入网页地址"
                  aria-label="网页地址"
                />
              </div>
              <button className="browser-go" type="submit" disabled={!browserLocation.trim() || browserBusy}>
                {browserBusy ? "打开中" : "打开"}<ExternalLink size={15} />
              </button>
              <button type="button" title="关闭页面" disabled={!browserState.open} onClick={() => void controlBrowser("close")}><X size={16} /></button>
            </form>
          </section>

          <section className={`browser-viewport-shell ${browserState.open ? "browser-viewport-shell--open" : ""}`}>
            <div className="browser-empty-state">
              <div className="surface-preview__icon"><Globe2 size={30} /></div>
              <span className="eyebrow">HUMAN · AI · WEB</span>
              <h2>打开一个共享页面</h2>
              <p>你和主 Agent 将观察并操作同一个内置 Chromium 页面。</p>
              <button className="primary-action" onClick={() => void openBrowser()}><Globe2 size={16} />打开示例页面</button>
            </div>
            <div className="browser-viewport" ref={browserViewportRef} aria-label="内置 Chromium 页面区域" />
          </section>

          {browserState.editMode && (
            <form className="surface-editor glass-panel" onSubmit={submitSurfaceEdit}>
              <div className="surface-editor__context">
                <span className={`surface-editor__target ${surfaceSelection ? "surface-editor__target--selected" : ""}`}>
                  <MousePointer2 size={14} />
                  {surfaceSelection
                    ? `${surfaceSelection.tagName}${surfaceSelection.nodeId ? ` · ${surfaceSelection.nodeId}` : ""}`
                    : "请点击页面中的元素"}
                </span>
                {surfaceSelection?.text && <span className="surface-editor__preview">{surfaceSelection.text}</span>}
                <button type="button" className="surface-editor__undo" disabled={surfaceBusy || surfaceTaskActive} onClick={() => void undoSurfaceEdit()}>
                  <Undo2 size={14} />撤销
                </button>
              </div>
              <div className="surface-editor__composer">
                <Sparkles size={17} />
                <textarea
                  value={surfaceInstruction}
                  onChange={(event) => setSurfaceInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={surfaceSelection ? "告诉 AI 这里要怎么改…" : "先在上方页面中选择一个元素"}
                  rows={1}
                  disabled={!surfaceSelection || surfaceTaskActive}
                />
                <button type="submit" disabled={!surfaceInstruction.trim() || !surfaceSelection || surfaceBusy || surfaceTaskActive}>
                  {surfaceTaskActive ? "修改中" : surfaceBusy ? "派发中" : "修改"}<Send size={15} />
                </button>
              </div>
              {(surfaceFeedback || surfaceTaskActive) && (
                <div className="surface-editor__feedback">
                  <span className={`status-dot status-dot--${surfaceTaskActive ? "running" : "completed"}`} />
                  {surfaceTaskActive ? surfaceTask?.progressMessage || "任务 Agent 正在修改画布" : surfaceFeedback}
                </div>
              )}
            </form>
          )}

          {browserError && <div className="browser-error">{browserError}</div>}
        </div>
      </section>

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
            void openTask(completedNotice);
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
