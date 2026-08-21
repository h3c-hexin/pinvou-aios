import React from "react";
import ReactDOM from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  CircleStop,
  ExternalLink,
  FileText,
  Globe2,
  LoaderCircle,
  Mic,
  Moon,
  MousePointer2,
  Plus,
  RefreshCw,
  Radio,
  Send,
  Sparkles,
  Sun,
  Undo2,
  X,
} from "lucide-react";
import "./styles.css";
import { ContinuousVoiceCapture, type ContinuousVoiceState, PcmAudioPlayer } from "./voice-runtime";

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
  activeArtifact?: {
    contextId: string;
    taskId: string;
    title: string;
    artifactRef: string;
    fileName: string;
    taskUpdatedAt: string;
  };
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
  canReturn?: boolean;
  contextDepth?: number;
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

type VoiceState = "idle" | "requesting" | "recording" | "recognizing" | "listening" | "hearing";
type VoiceMode = "push" | "continuous";
type ThemeMode = "light" | "dark";

const maximumVoiceRecordingMs = 120_000;
const themeStorageKey = "pinvou-theme-mode";

function preferredRecordingMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

function appendTranscript(current: string, transcript: string) {
  if (!current.trim()) return transcript;
  return `${current}${/\s$/.test(current) ? "" : " "}${transcript}`;
}

function voiceFailureMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message.includes("PINVOU_TOKEN_PLAN_API_KEY")) {
    return "语音识别未配置，暂时只能使用文字输入";
  }
  if (message.includes("voice:recognize")) {
    return "语音识别暂不可用，请稍后重试";
  }
  if (reason instanceof DOMException) {
    if (reason.name === "NotAllowedError") return "未获得麦克风权限，请在系统设置中允许 Pinvou AIOS 使用麦克风";
    if (reason.name === "NotFoundError") return "没有检测到可用的麦克风";
    if (reason.name === "NotReadableError") return "麦克风暂时不可用，可能正被其他程序占用";
  }
  return message;
}

function friendlyRuntimeError(message: string) {
  if (message.includes("daemon:request") || message.includes("aios.sock") || message.includes("ENOENT")) {
    return "后台服务未连接";
  }
  return message;
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
  const [themeMode, setThemeMode] = React.useState<ThemeMode>(() => {
    const saved = window.localStorage.getItem(themeStorageKey);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
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
  const [voiceState, setVoiceState] = React.useState<VoiceState>("idle");
  const [voiceMode, setVoiceMode] = React.useState<VoiceMode>("push");
  const [voiceOutputState, setVoiceOutputState] = React.useState<string>("idle");
  const [voiceError, setVoiceError] = React.useState<string>();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const browserViewportRef = React.useRef<HTMLDivElement>(null);
  const observedTaskStates = React.useRef<Map<string, TaskState>>(new Map());
  const taskStateHydrated = React.useRef(false);
  const voiceRecorderRef = React.useRef<MediaRecorder | undefined>(undefined);
  const voiceStreamRef = React.useRef<MediaStream | undefined>(undefined);
  const voiceChunksRef = React.useRef<Blob[]>([]);
  const voiceRecordingTimerRef = React.useRef<number | undefined>(undefined);
  const voiceCancelledRef = React.useRef(false);
  const voiceMountedRef = React.useRef(true);
  const voiceCaptureRef = React.useRef<ContinuousVoiceCapture | undefined>(undefined);
  const voicePlayerRef = React.useRef(new PcmAudioPlayer());
  const voiceStreamTextRef = React.useRef("");

  React.useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = themeMode;
    window.localStorage.setItem(themeStorageKey, themeMode);
    void window.pinvou.setThemeMode(themeMode).catch(() => undefined);
  }, [themeMode]);

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

  React.useEffect(() => {
    const removeEvent = window.pinvou.onDaemonEvent((event) => {
      if (event.event === "snapshot.changed") void refresh();
      if (event.event === "main.turn.started") {
        voiceStreamTextRef.current = "";
      }
      if (event.event === "main.turn.delta") {
        const delta = typeof event.data?.delta === "string" ? event.data.delta : "";
        if (delta) {
          voiceStreamTextRef.current += delta;
          setSnapshot((current) => ({
            ...current,
            main: { ...current.main, streamingText: voiceStreamTextRef.current },
          }));
        }
      }
      if (["main.turn.completed", "main.turn.failed", "main.turn.interrupted"].includes(event.event)) {
        voiceStreamTextRef.current = "";
        void refresh();
      }
    });
    const removeAudio = window.pinvou.onVoiceAudio(({ audio, sampleRate }) => {
      void voicePlayerRef.current.push(audio, sampleRate).catch((reason) => {
        setVoiceError(voiceFailureMessage(reason));
      });
    });
    const removeClear = window.pinvou.onVoiceClearAudio(() => voicePlayerRef.current.clear());
    const removeOutputState = window.pinvou.onVoiceOutputState((state) => {
      setVoiceOutputState(state.state);
      if (state.state === "error" && state.error) setVoiceError(state.error);
    });
    const removeFallback = window.pinvou.onVoiceFallback(({ text }) => {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "zh-CN";
      utterance.rate = 1.05;
      const voices = window.speechSynthesis.getVoices();
      utterance.voice = voices.find((voice) => voice.lang.toLowerCase().startsWith("zh")) || null;
      utterance.onstart = () => setVoiceOutputState("fallback");
      utterance.onend = () => setVoiceOutputState("finished");
      utterance.onerror = () => setVoiceError("云端 TTS 暂不可用，本机也没有可用的中文语音");
      window.speechSynthesis.speak(utterance);
    });
    const removeCancelFallback = window.pinvou.onVoiceCancelFallback(() => window.speechSynthesis.cancel());
    return () => {
      removeEvent();
      removeAudio();
      removeClear();
      removeOutputState();
      removeFallback();
      removeCancelFallback();
    };
  }, [refresh]);

  React.useEffect(() => {
    voiceMountedRef.current = true;
    return () => {
      voiceMountedRef.current = false;
      voiceCancelledRef.current = true;
      if (voiceRecordingTimerRef.current) window.clearTimeout(voiceRecordingTimerRef.current);
      const recorder = voiceRecorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
      void voiceCaptureRef.current?.stop();
      void voicePlayerRef.current.close();
    };
  }, []);

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

  async function waitForMainIdle(maximumMs = 8_000) {
    const deadline = Date.now() + maximumMs;
    while (Date.now() < deadline) {
      const current = await daemonRequest<Snapshot>("snapshot.get");
      if (current.main.status === "idle") return;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    throw new Error("主 Agent 未能及时停止上一轮对话");
  }

  async function submitVoiceTranscript(transcript: string) {
    const message = transcript.trim();
    if (!message) return;
    const current = await daemonRequest<Snapshot>("snapshot.get");
    if (current.main.status !== "idle") {
      await daemonRequest("main.interrupt");
      await waitForMainIdle();
    }
    await daemonRequest("main.voice_prompt", {
      message,
      turnId: `voice:${crypto.randomUUID()}`,
    });
    await refresh();
  }

  async function recognizeAndSubmit(audio: ArrayBuffer, mimeType: string, sampleRate?: number) {
    const result = await window.pinvou.voiceRecognize(audio, mimeType, sampleRate);
    await submitVoiceTranscript(result.text);
    setVoiceError(undefined);
  }

  function stopVoiceRecording() {
    const recorder = voiceRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    setVoiceState("recognizing");
    recorder.stop();
  }

  async function startVoiceRecording() {
    if (voiceState !== "idle") return;
    setVoiceError(undefined);
    setVoiceState("requesting");
    try {
      voicePlayerRef.current.clear();
      await window.pinvou.voiceInterruptOutput();
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("当前系统不支持麦克风录音");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (!voiceMountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const preferredMimeType = preferredRecordingMimeType();
      const recorder = new MediaRecorder(
        stream,
        preferredMimeType ? { mimeType: preferredMimeType } : undefined,
      );
      voiceStreamRef.current = stream;
      voiceRecorderRef.current = recorder;
      voiceChunksRef.current = [];
      voiceCancelledRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) voiceChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        voiceCancelledRef.current = true;
        if (voiceRecordingTimerRef.current) window.clearTimeout(voiceRecordingTimerRef.current);
        stream.getTracks().forEach((track) => track.stop());
        voiceRecorderRef.current = undefined;
        voiceStreamRef.current = undefined;
        setVoiceState("idle");
        setVoiceError("录音失败，请检查麦克风后重试");
      };
      recorder.onstop = async () => {
        if (voiceRecordingTimerRef.current) window.clearTimeout(voiceRecordingTimerRef.current);
        voiceRecordingTimerRef.current = undefined;
        stream.getTracks().forEach((track) => track.stop());
        voiceRecorderRef.current = undefined;
        voiceStreamRef.current = undefined;

        if (voiceCancelledRef.current) {
          voiceChunksRef.current = [];
          return;
        }

        const mimeType = recorder.mimeType || preferredMimeType || "audio/webm";
        const audio = new Blob(voiceChunksRef.current, { type: mimeType });
        voiceChunksRef.current = [];
        if (audio.size === 0) {
          setVoiceState("idle");
          setVoiceError("没有录到声音，请重试");
          return;
        }

        setVoiceState("recognizing");
        try {
          const sampleRate = stream.getAudioTracks()[0]?.getSettings().sampleRate;
          await recognizeAndSubmit(
            await audio.arrayBuffer(),
            mimeType,
            sampleRate,
          );
        } catch (reason) {
          setVoiceError(voiceFailureMessage(reason));
        } finally {
          setVoiceState("idle");
        }
      };

      recorder.start(250);
      setVoiceState("recording");
      voiceRecordingTimerRef.current = window.setTimeout(
        stopVoiceRecording,
        maximumVoiceRecordingMs,
      );
    } catch (reason) {
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
      voiceStreamRef.current = undefined;
      voiceRecorderRef.current = undefined;
      setVoiceState("idle");
      setVoiceError(voiceFailureMessage(reason));
    }
  }

  function toggleVoiceRecording() {
    if (voiceMode === "continuous") {
      if (voiceCaptureRef.current) void stopContinuousVoice();
      else void startContinuousVoice();
      return;
    }
    if (voiceState === "recording") stopVoiceRecording();
    else if (voiceState === "idle") void startVoiceRecording();
  }

  async function startContinuousVoice() {
    if (voiceCaptureRef.current) return;
    setVoiceError(undefined);
    const capture = new ContinuousVoiceCapture({
      onState(state: ContinuousVoiceState) {
        if (state === "off") setVoiceState("idle");
        else setVoiceState(state);
      },
      async onSpeechStart() {
        voicePlayerRef.current.clear();
        await window.pinvou.voiceInterruptOutput();
      },
      async onUtterance(audio) {
        await recognizeAndSubmit(audio, "audio/wav", 16_000);
      },
      onError(reason) {
        setVoiceError(voiceFailureMessage(reason));
      },
    });
    voiceCaptureRef.current = capture;
    try {
      await capture.start();
    } catch {
      voiceCaptureRef.current = undefined;
      setVoiceState("idle");
    }
  }

  async function stopContinuousVoice() {
    const capture = voiceCaptureRef.current;
    voiceCaptureRef.current = undefined;
    await capture?.stop();
    setVoiceState("idle");
  }

  async function changeVoiceMode() {
    if (voiceCaptureRef.current) await stopContinuousVoice();
    setVoiceMode((current) => current === "push" ? "continuous" : "push");
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

  async function controlBrowser(action: "back" | "forward" | "reload" | "close" | "return") {
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
  const showRuntimeStatus = Boolean(error) || mainNeedsSetup || ["starting", "thinking"].includes(snapshot.main.status);
  const surfaceTask = snapshot.tasks.find((task) => task.id === browserState.taskId);
  const surfaceTaskActive = surfaceTask?.state === "queued" || surfaceTask?.state === "running";
  const darkMode = themeMode === "dark";

  return (
    <main className="shell">
      <div className="aurora aurora--one" />
      <div className="aurora aurora--two" />

      <section className="conversation glass-panel">
        <header className="topbar topbar--agent">
          <div>
            <h1>AI 对话</h1>
          </div>
          <div className="topbar-actions">
            <button
              className={`theme-toggle${darkMode ? " theme-toggle--dark" : ""}`}
              type="button"
              title={darkMode ? "切换到浅色模式" : "切换到深色模式"}
              aria-label={darkMode ? "当前深色模式，切换到浅色模式" : "当前浅色模式，切换到深色模式"}
              aria-pressed={darkMode}
              onClick={() => setThemeMode(darkMode ? "light" : "dark")}
            >
              <span className="theme-toggle__thumb">
                {darkMode ? <Moon size={14} /> : <Sun size={14} />}
              </span>
            </button>
            {showRuntimeStatus && (
              <div className="runtime-pill">
                <span className={`status-dot status-dot--${error || mainNeedsSetup ? "failed" : "running"}`} />
                {error ? "未连接" : snapshot.main.status === "thinking" ? "思考中" : snapshot.main.status === "needs_setup" ? "待配置模型" : snapshot.main.status === "offline" ? "离线" : "启动中"}
              </div>
            )}
          </div>
        </header>

        <div className="message-stream" ref={scrollRef}>
          {messages.length === 0 && !snapshot.main.streamingText ? (
            <div className="welcome-card">
              <h2>今天想做什么？</h2>
              <div className="suggestions">
                <button onClick={() => setInput("帮我整理一份本周工作汇报")}>整理汇报</button>
                <button onClick={() => setInput("研究一个主题并给我结论")}>研究总结</button>
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

        {orderedTasks.length > 0 && (
          <section className="process-strip" aria-label="后台任务">
            <div className="process-strip__list">
              {orderedTasks.slice(0, 3).map((task) => (
                <TaskChip
                  key={task.id}
                  task={task}
                  onOpen={() => void openTask(task)}
                  onCancel={() => void cancelTask(task)}
                />
              ))}
            </div>
          </section>
        )}

        <form className="composer" onSubmit={sendMessage}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Let's write or build together"
            rows={1}
          />
          <div className="composer-toolbar">
            <div className="composer-tools">
              <button
                className="icon-button composer-plus"
                type="button"
                title="创建后台任务"
                onClick={() => setManualTask(true)}
              >
                <Plus size={20} />
              </button>
              <button
                className={`voice-mode-toggle ${voiceMode === "continuous" ? "voice-mode-toggle--active" : ""}`}
                type="button"
                title={voiceMode === "push" ? "切换到连续对话" : "切换到单次对话"}
                aria-label={voiceMode === "push" ? "当前单次对话，切换到连续对话" : "当前连续对话，切换到单次对话"}
                onClick={() => void changeVoiceMode()}
              >
                <Radio size={13} />
                <span>{voiceMode === "continuous" ? "连续" : "单次"}</span>
              </button>
            </div>
            <div className="composer-tools composer-tools--right">
            <button
              className={`icon-button voice-button voice-button--${voiceState}`}
              type="button"
              title={voiceMode === "continuous"
                ? voiceState === "idle" ? "开始连续语音对话" : "停止连续语音对话"
                : voiceState === "recording" ? "点击停止并识别" : voiceState === "idle" ? "点击开始单次语音对话" : "正在处理语音"}
              aria-label={voiceState === "recording" ? "停止录音" : "开始语音输入"}
              aria-pressed={voiceState === "recording"}
              disabled={sending || (voiceMode === "push" && voiceState !== "idle" && voiceState !== "recording")}
              onClick={toggleVoiceRecording}
            >
              {voiceState === "recording" || voiceState === "hearing"
                ? <CircleStop size={19} />
                : voiceState === "requesting" || voiceState === "recognizing"
                  ? <LoaderCircle className="spin" size={19} />
                  : <Mic size={19} />}
            </button>
              <button className="send-button" type="submit" disabled={!input.trim() || sending}>
                <Send size={18} />
              </button>
            </div>
          </div>
        </form>
        <div className="composer-feedback" aria-live="polite">
          {snapshot.activeArtifact && (
            <div className="artifact-context-banner">
              <FileText size={14} />
              <span>
                <b>当前产物</b>
                <small>{snapshot.activeArtifact.title} · {snapshot.activeArtifact.fileName}</small>
              </span>
              <button
                type="button"
                title="返回进入任务产物前的环境"
                onClick={() => void controlBrowser("return")}
              >
                <X size={13} />
              </button>
            </div>
          )}
          {voiceState !== "idle" && (
            <div className={`voice-banner voice-banner--${voiceState}`}>
              <span className="voice-level"><i /><i /><i /></span>
              {voiceState === "requesting" && "正在请求麦克风权限…"}
              {voiceState === "recording" && "正在录音，再次点击麦克风即可停止"}
              {voiceState === "listening" && "连续对话已开启，正在等待你说话…"}
              {voiceState === "hearing" && "正在听，你可以随时打断 Pinvou"}
              {voiceState === "recognizing" && "千问正在识别…"}
            </div>
          )}
          {["speaking", "fallback"].includes(voiceOutputState) && voiceState === "idle" && (
            <div className="voice-banner"><span className="voice-level"><i /><i /><i /></span>{voiceOutputState === "fallback" ? "Pinvou 正在使用本机语音" : "Pinvou 正在说话"}</div>
          )}
          {voiceError && <div className="error-banner">{voiceError}</div>}
          {error && <div className="error-banner">{friendlyRuntimeError(error)}</div>}
        </div>
      </section>

      <section className="browser-workspace">
        <div className="browser-stage">
          <section className="browser-console glass-panel">
            <div className="browser-console__heading">
              <span className="browser-lights"><i /><i /><i /></span>
              <span className="browser-console__title">{browserState.open ? browserState.title || "网页" : ""}</span>
              {(browserState.open || browserState.loading) && (
                <span className="surface-badge">
                  <span className={`status-dot status-dot--${browserState.open ? "running" : "queued"}`} />
                  {browserState.loading ? "加载中" : "共享页面"}
                </span>
              )}
            </div>
            <form className={`browser-toolbar ${browserState.editable || browserState.editMode ? "" : "browser-toolbar--plain"}`} onSubmit={openBrowser}>
              <button type="button" title="后退" disabled={!browserState.open} onClick={() => void controlBrowser("back")}><ArrowLeft size={17} /></button>
              <button type="button" title="前进" disabled={!browserState.open} onClick={() => void controlBrowser("forward")}><ArrowRight size={17} /></button>
              <button type="button" title="刷新" disabled={!browserState.open} onClick={() => void controlBrowser("reload")}><RefreshCw size={16} /></button>
              {(browserState.editable || browserState.editMode) && (
                <button
                  className={`surface-edit-toggle ${browserState.editMode ? "surface-edit-toggle--active" : ""}`}
                  type="button"
                  title="点击页面元素并告诉 AI 如何修改"
                  disabled={!browserState.editable}
                  onClick={() => void toggleSurfaceEdit()}
                >
                  <MousePointer2 size={15} /><span>AI 修改</span>
                </button>
              )}
              <div className="browser-address">
                <Globe2 size={15} />
                <input
                  value={browserLocation}
                  onChange={(event) => setBrowserLocation(event.target.value)}
                  placeholder="输入网页地址"
                  aria-label="网页地址"
                />
              </div>
              <button
                className="browser-go"
                type="submit"
                title={browserBusy ? "正在打开" : "打开网页"}
                aria-label={browserBusy ? "正在打开" : "打开网页"}
                disabled={!browserLocation.trim() || browserBusy}
              >
                {browserBusy ? <RefreshCw size={15} /> : <ExternalLink size={16} />}
              </button>
              <button
                type="button"
                title={browserState.canReturn ? "返回进入任务产物前的环境" : "关闭页面"}
                disabled={!browserState.open}
                onClick={() => void controlBrowser("close")}
              ><X size={16} /></button>
            </form>
          </section>

          <section className={`browser-viewport-shell ${browserState.open ? "browser-viewport-shell--open" : ""}`}>
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
