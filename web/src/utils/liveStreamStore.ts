export interface LiveStreamSnapshot {
  reasoning: string;
  text: string;
}

export class LiveStreamBufferStore {
  private snapshot: LiveStreamSnapshot = { reasoning: '', text: '' };
  private listeners = new Set<() => void>();
  private rafId: number | null = null;

  getSnapshot = (): LiveStreamSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private scheduleNotify() {
    if (this.rafId !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.listeners.forEach((fn) => fn());
      });
    } else {
      this.listeners.forEach((fn) => fn());
    }
  }

  appendReasoning(delta: string) {
    if (!delta) return;
    this.snapshot = {
      ...this.snapshot,
      reasoning: this.snapshot.reasoning + delta,
    };
    this.scheduleNotify();
  }

  appendText(delta: string) {
    if (!delta) return;
    this.snapshot = {
      ...this.snapshot,
      text: this.snapshot.text + delta,
    };
    this.scheduleNotify();
  }

  reset() {
    if (!this.snapshot.reasoning && !this.snapshot.text) return;
    this.snapshot = { reasoning: '', text: '' };
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.listeners.forEach((fn) => fn());
  }
}
