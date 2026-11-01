/** Session clock: 0 at receipt of `session.started` (monotonic `performance.now`). Approximation of the gateway clock. */
export class SessionClock {
  private startMono: number | null = null;
  constructor(private now: () => number = () => performance.now()) {}
  start(): void {
    this.startMono = this.now();
  }
  get running(): boolean {
    return this.startMono !== null;
  }
  /** Integer ms since start; 0 before start. Never negative. */
  ms(): number {
    return this.startMono === null ? 0 : Math.max(0, Math.round(this.now() - this.startMono));
  }
  stop(): void {
    this.startMono = null;
  }
}
