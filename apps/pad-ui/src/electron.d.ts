export {};

type BrowserAction = "back" | "forward" | "reload" | "close";

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
  voiceRecognize(
    audio: ArrayBuffer,
    mimeType: string,
    sampleRate?: number,
  ): Promise<{ text: string; requestId?: string; model: string }>;
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
}

declare global {
  interface Window {
    pinvou: PinvouBridge;
  }
}
