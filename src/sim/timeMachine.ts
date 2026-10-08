/**
 * Rewind by snapshot + deterministic replay. Snapshots are taken every `every` steps;
 * seeking restores the nearest earlier snapshot and re-simulates forward, replaying
 * any user inputs at the exact step they originally happened. Because the sim is a
 * pure function of (state, inputs, step), the replay lands on the same frame.
 */
export interface TimeMachineHooks<S> {
  capture(): S;
  restore(s: S): void;
  /** Advance exactly one fixed step (the caller increments its own step counter). */
  step(): void;
  /** Approximate retained bytes of one captured state; enables the `maxBytes` bound. */
  sizeOf?(s: S): number;
}

interface Snap<S> {
  step: number;
  state: S;
  bytes: number;
}

interface LoggedInput {
  step: number;
  apply: () => void;
}

export class TimeMachine<S> {
  /** Latest step reached in live play. */
  liveStep = 0;
  /** Step currently shown; equals liveStep unless reviewing. */
  viewStep = 0;
  private snaps: Snap<S>[] = [];
  private inputs: LoggedInput[] = [];
  private retained = 0;

  /**
   * @param maxBytes upper bound on retained snapshot bytes (needs `hooks.sizeOf`); the oldest
   *   snapshots are evicted first, so the reachable history shrinks instead of RAM growing.
   */
  constructor(
    private readonly hooks: TimeMachineHooks<S>,
    readonly every: number,
    readonly window: number,
    readonly maxBytes: number = Infinity,
  ) {}

  /** Bytes currently retained by snapshots (0 when `sizeOf` is not provided). */
  get bytes(): number {
    return this.retained;
  }

  get reviewing(): boolean {
    return this.viewStep < this.liveStep;
  }

  /** Oldest step that can still be reached. */
  get earliest(): number {
    return Math.max(this.snaps.length ? this.snaps[0].step : this.liveStep, this.liveStep - this.window);
  }

  /** Called after each live step. */
  afterLiveStep(step: number): void {
    this.liveStep = step;
    this.viewStep = step;
    if (step % this.every !== 0) return;
    const state = this.hooks.capture();
    const bytes = this.hooks.sizeOf ? this.hooks.sizeOf(state) : 0;
    this.snaps.push({ step, state, bytes });
    this.retained += bytes;
    const cutoff = step - this.window - this.every;
    while (this.snaps.length > 1 && this.snaps[1].step <= cutoff) this.dropOldest();
    while (this.snaps.length > 1 && this.retained > this.maxBytes) this.dropOldest();
    while (this.inputs.length && this.inputs[0].step <= this.snaps[0].step) this.inputs.shift();
  }

  private dropOldest(): void {
    const old = this.snaps.shift();
    if (old) this.retained -= old.bytes;
  }

  /** Records an input that takes effect at `step` (before that step is simulated). */
  logInput(step: number, apply: () => void): void {
    this.inputs.push({ step, apply });
  }

  /** Jump to any reachable step at or before the live step. */
  seek(target: number): void {
    const t = Math.max(this.earliest, Math.min(this.liveStep, Math.round(target)));
    let base = this.snaps[0];
    for (const s of this.snaps) if (s.step <= t) base = s;
    if (!base) return;
    this.hooks.restore(base.state);
    let k = 0;
    while (k < this.inputs.length && this.inputs[k].step <= base.step) k++;
    for (let st = base.step + 1; st <= t; st++) {
      while (k < this.inputs.length && this.inputs[k].step === st) this.inputs[k++].apply();
      this.hooks.step();
    }
    this.viewStep = t;
  }

  /** Make the viewed moment the new present, discarding the old future. */
  branch(): void {
    const at = this.viewStep;
    this.snaps = this.snaps.filter((s) => s.step <= at);
    this.retained = this.snaps.reduce((sum, s) => sum + s.bytes, 0);
    this.inputs = this.inputs.filter((e) => e.step <= at);
    this.liveStep = at;
  }
}
