// Cancelling a running request (2026-11-17). The agent server runs each request inside `withCancel`; when the user
// stops it (the launcher's Stop button, POST /v1/cancel, or the client closing the connection), the request's
// AbortSignal fires and:
//   - every child process started for the request (mdfind, sips, pdftool, latexmk, git, …) is killed: execFile and
//     spawn get the signal unless they pass their own (installed once with `installCancelHooks`)
//   - every HTTP call (AFM/apfel, Decima, web) is aborted: fetch gets the signal combined with its own
//   - the controller stops at the next AFM call or step (`checkCancelled` throws `Cancelled`)
// Work outside a request (the server's own start-up) is untouched. Detached background sessions (tmux) are started
// with their own lifetime and are not killed. Files are written to a temporary name and renamed only when complete
// (atomic.ts), so a stopped request leaves no half-written file.
import { AsyncLocalStorage } from "node:async_hooks";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const store = new AsyncLocalStorage<AbortSignal>();

export class Cancelled extends Error {
  constructor() { super("cancelled by the user"); this.name = "Cancelled"; }
}

/** The signal of the request this code runs for, if any. */
export const currentSignal = (): AbortSignal | undefined => store.getStore();
export const isCancelled = () => !!store.getStore()?.aborted;
export function checkCancelled(): void { if (store.getStore()?.aborted) throw new Cancelled(); }

/** Runs `f` with `signal` as the request's cancel signal. */
export function withCancel<T>(signal: AbortSignal, f: () => Promise<T>): Promise<T> {
  return store.run(signal, f);
}

let installed = false;
/** Gives child processes and fetch calls the current request's signal. Idempotent. */
export function installCancelHooks(): void {
  if (installed) return;
  installed = true;
  const cp = childProcess as any;
  const withSignal = (args: any[], optAt: (a: any[]) => number) => {
    const s = store.getStore();
    if (!s) return args;
    const i = optAt(args);
    const a = [...args];
    if (i < a.length && a[i] && typeof a[i] === "object" && !Array.isArray(a[i])) {
      if (a[i].detached || a[i].signal) return args;   // own lifetime, or own signal
      a[i] = { ...a[i], signal: s };
    } else a.splice(i, 0, { signal: s });
    return a;
  };
  // execFile(file, [args], [options], [callback]): options come after the args array, if any
  const execFileOpt = (a: any[]) => (Array.isArray(a[1]) ? 2 : 1);
  const origExecFile = cp.execFile;
  cp.execFile = function (...args: any[]) { return origExecFile.apply(this, withSignal(args, execFileOpt)); };
  const origSpawn = cp.spawn;
  cp.spawn = function (...args: any[]) { return origSpawn.apply(this, withSignal(args, execFileOpt)); };
  // (util.promisify(execFile) is not used in this code base; a promisified copy would bypass the signal)
  syncBuiltinESMExports();

  const origFetch = globalThis.fetch;
  globalThis.fetch = ((input: any, init: any = {}) => {
    const s = store.getStore();
    if (!s) return origFetch(input, init);
    const signal = init.signal ? AbortSignal.any([init.signal, s]) : s;
    return origFetch(input, { ...init, signal });
  }) as typeof fetch;
}
