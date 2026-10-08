import { ALL_RED, AMBER, type Junction } from './network';

export const enum Light {
  Red = 0,
  Amber = 1,
  Green = 2,
  /** Late-night flashing amber: the junction runs unsignalled, everyone slows and gives way. */
  Flash = 3,
}

/** Saigon switches most junction signals to flashing amber late at night. */
export const flashHours = (hour: number): boolean => hour >= 23 || hour < 5;

export interface SignalTiming {
  junction: Junction;
  green: [number, number];
  offset: number;
  cycle: number;
}

/**
 * Two-phase fixed-time plans (group 0, then group 1) with countdowns, as on Saigon
 * junctions. State is a pure function of sim time, so it never drifts. Plans come from the
 * junctions' `signal` (set by the map builder); `nodeIndex` is the position in the list.
 */
export class SignalSystem {
  readonly plans: SignalTiming[];
  /** Output of the last query, reused to avoid allocation. */
  readonly out = { light: Light.Red as Light, remaining: 0 };
  /** Set from the sim hour each step (see `flashHours`). */
  flashing = false;

  constructor(junctions: Junction[]) {
    this.plans = junctions.map((junction) => {
      const sp = junction.signal;
      if (!sp) throw new Error(`junction ${junction.key} has no signal plan`);
      return { junction, green: sp.green, offset: sp.offset, cycle: sp.cycle };
    });
  }

  query(nodeIndex: number, group: number, t: number): typeof this.out {
    if (this.flashing) {
      this.out.light = Light.Flash;
      this.out.remaining = 0;
      return this.out;
    }
    const p = this.plans[nodeIndex];
    const C = p.cycle;
    const start = group === 0 ? 0 : p.green[0] + AMBER + ALL_RED;
    const g = p.green[group];
    const tau = (((t + p.offset - start) % C) + C) % C;
    if (tau < g) {
      this.out.light = Light.Green;
      this.out.remaining = g - tau;
    } else if (tau < g + AMBER) {
      this.out.light = Light.Amber;
      this.out.remaining = g + AMBER - tau;
    } else {
      this.out.light = Light.Red;
      this.out.remaining = C - tau;
    }
    return this.out;
  }
}
