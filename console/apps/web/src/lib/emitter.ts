export type Listener<T> = (payload: T) => void;

/** Minimal typed event emitter. `M` maps event name -> payload. */
export class Emitter<M extends Record<string, unknown>> {
  private listeners: { [K in keyof M]?: Set<Listener<M[K]>> } = {};

  on<K extends keyof M>(name: K, fn: Listener<M[K]>): () => void {
    (this.listeners[name] ??= new Set()).add(fn);
    return () => this.off(name, fn);
  }
  off<K extends keyof M>(name: K, fn: Listener<M[K]>): void {
    this.listeners[name]?.delete(fn);
  }
  protected emit<K extends keyof M>(name: K, payload: M[K]): void {
    for (const fn of [...(this.listeners[name] ?? [])]) {
      try {
        fn(payload);
      } catch (e) {
        console.error("listener error", name, e);
      }
    }
  }
}
