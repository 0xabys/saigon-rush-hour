/**
 * Minimal ambient declarations for the Node-compatible APIs the OSM scripts use (run with bun).
 * `@types/node` is deliberately not a dependency.
 */
declare module 'node:stream' {
  export interface Readable extends AsyncIterable<Uint8Array> {
    on(event: 'error', listener: (err: Error) => void): this;
    pipe(dest: Duplex): Duplex;
  }
  export interface Duplex extends Readable {
    destroy(err?: Error): void;
  }
  export const Readable: { from(source: AsyncIterable<Uint8Array>): Readable };
}

declare module 'node:zlib' {
  import type { Duplex } from 'node:stream';
  export function createGunzip(): Duplex;
}

declare module 'node:readline' {
  import type { Readable } from 'node:stream';
  export function createInterface(options: { input: Readable; crlfDelay: number }): AsyncIterable<string>;
}

declare module 'node:fs' {
  import type { Readable } from 'node:stream';
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: Uint8Array): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { size: number };
  export function createReadStream(path: string): Readable;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module 'node:path' {
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
}

declare module 'node:crypto' {
  export function createHash(algorithm: 'sha1' | 'sha256'): { update(data: string): { digest(encoding: 'hex'): string } };
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  stdout: { write(text: string): void };
};
