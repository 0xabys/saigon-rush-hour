import type { MapNode } from './network';

export const enum Light {
  Red = 0,
  Amber = 1,
  Green = 2,
  /** Late-night flashing amber: the junction runs unsignalled, everyone slows and gives way. */
  Flash = 3,
}

/** Saigon switches most junction signals to flashing amber late at night. */
export const flashHours = (hour: number): boolean => hour >= 23 || hour < 5;

const AMBER = 3;
const ALL_RED = 2;

export interface SignalPlan {
  node: MapNode;
  green: [number, number];
  offset: number;
  cycle: number;
}

/**
 * Two-phase fixed-time plans (north–south, then east–west) with countdowns, as on
 * Saigon junctions. State is a pure function of sim time, so it never drifts.
 */
export class SignalSystem {
  readonly plans: SignalPlan[];
  /** Output of the last query, reused to avoid allocation. */
  readonly out = { light: Light.Red as Light, remaining: 0 };
  /** Set from the sim hour each step (see `flashHours`). */
  flashing = false;

  constructor(nodes: MapNode[]) {
    const greens: Record<string, [number, number]> = {
      BN: [20, 24],
      BM: [22, 18],
      BS: [20, 24],
      CN: [20, 22],
      CS: [22, 18],
      DN: [26, 22],
    };
    const offsets: Record<string, number> = { BN: 0, BM: 9, BS: 17, CN: 6, CS: 21, DN: 13 };
    this.plans = nodes.map((node) => {
      const green = greens[node.key] ?? [20, 20];
      return {
        node,
        green,
        offset: offsets[node.key] ?? 0,
        cycle: green[0] + green[1] + 2 * (AMBER + ALL_RED),
      };
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
