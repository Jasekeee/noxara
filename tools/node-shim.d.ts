// Minimal Node typings for tools/** and tests/** (the repo has no @types/node; tsconfig "types" is
// ["vite/client"]). Only what our scripts use. If the lead adds @types/node, delete this file.
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  exit(code?: number): never;
  cwd(): string;
  stdout: { write(s: string): boolean };
};

declare module "node:fs" {
  export function readFileSync(path: string, enc: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function renameSync(from: string, to: string): void;
  export function rmSync(path: string, opts?: { force?: boolean; recursive?: boolean }): void;
}

declare module "node:path" {
  export function join(...p: string[]): string;
  export function resolve(...p: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string, ext?: string): string;
  export function relative(from: string, to: string): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module "node:module" {
  interface ResolveContext {
    parentURL?: string;
    conditions: string[];
  }
  interface ResolveResult {
    url: string;
    format?: string | null;
    shortCircuit?: boolean;
  }
  export function registerHooks(hooks: {
    resolve?: (
      specifier: string,
      context: ResolveContext,
      nextResolve: (specifier: string, context?: ResolveContext) => ResolveResult,
    ) => ResolveResult;
  }): unknown;
}

declare module "node:child_process" {
  export function spawnSync(
    cmd: string,
    args: string[],
    opts?: { stdio?: "inherit" | "pipe"; encoding?: "utf8"; env?: Record<string, string | undefined> },
  ): { status: number | null; stdout: string; stderr: string; error?: Error };
}
