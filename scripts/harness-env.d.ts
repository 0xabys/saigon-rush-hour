/**
 * Ambient declarations for the extra Node-compatible APIs scripts/harness.ts uses (child processes, temp
 * dirs). Merges with scripts/osm/env.d.ts; `@types/node` is deliberately not a dependency.
 */
declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
  export function cpus(): unknown[];
}

declare module 'node:child_process' {
  export interface ChildStream {
    on(event: 'data', listener: (chunk: { toString(): string }) => void): void;
  }
  export interface ChildProcess {
    stdout: ChildStream;
    stderr: ChildStream;
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'close', listener: (code: number | null) => void): void;
  }
  export function spawn(command: string, args: string[], options: { stdio: ['ignore', 'pipe', 'pipe'] }): ChildProcess;
}
