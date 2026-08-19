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
}

interface PinvouBridge {
  daemonRequest<T>(method: string, params?: Record<string, unknown>): Promise<T>;
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
  onBrowserState(listener: (state: PinvouBrowserState) => void): () => void;
}

declare global {
  interface Window {
    pinvou: PinvouBridge;
  }
}
