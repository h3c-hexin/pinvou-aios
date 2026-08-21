export {};

type BrowserAction = "back" | "forward" | "reload" | "close" | "return";

interface PinvouBrowserState {
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
  selection?: PinvouSurfaceSelection;
}

interface PinvouSurfaceSelection {
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

interface PinvouBridge {
  daemonRequest<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  setThemeMode(mode: "light" | "dark"): Promise<{ mode: "system" | "light" | "dark"; dark: boolean }>;
  voiceRecognize(
    audio: ArrayBuffer,
    mimeType: string,
    sampleRate?: number,
  ): Promise<{ text: string; requestId?: string; model: string }>;
  voiceInterruptOutput(): Promise<{ interrupted: boolean }>;
  browserStatus(): Promise<PinvouBrowserState>;
  browserOpen(location: string): Promise<PinvouBrowserState>;
  browserOpenTaskArtifact(taskId: string, location: string): Promise<PinvouBrowserState>;
  browserControl(action: BrowserAction): Promise<PinvouBrowserState>;
  browserSetBounds(bounds: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    visible: boolean;
  }): Promise<PinvouBrowserState>;
  surfaceSetEditMode(enabled: boolean): Promise<PinvouBrowserState>;
  surfaceClearSelection(): Promise<PinvouBrowserState>;
  surfaceModify(instruction: string): Promise<unknown>;
  surfaceUndo(): Promise<unknown>;
  onBrowserState(listener: (state: PinvouBrowserState) => void): () => void;
  onSurfaceSelection(listener: (selection?: PinvouSurfaceSelection) => void): () => void;
  onDaemonEvent(listener: (event: {
    type: "event";
    event: string;
    data?: Record<string, unknown>;
  }) => void): () => void;
  onVoiceAudio(listener: (chunk: { audio: Uint8Array; sampleRate: number }) => void): () => void;
  onVoiceClearAudio(listener: () => void): () => void;
  onVoiceOutputState(listener: (state: {
    state: "connecting" | "speaking" | "finished" | "stopped" | "disabled" | "error" | "fallback";
    error?: string;
    model?: string;
    voice?: string;
  }) => void): () => void;
  onVoiceFallback(listener: (value: { text: string }) => void): () => void;
  onVoiceCancelFallback(listener: () => void): () => void;
}

declare global {
  interface Window {
    pinvou: PinvouBridge;
  }
}
