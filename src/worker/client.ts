import type { BuildRequest, BuildResult } from '../core/types';

type Msg =
  | { type: 'ready'; engine: 'wasm' | 'js' }
  | { type: 'fatal'; error: string }
  | { type: 'result'; result: BuildResult }
  | { type: 'error'; id: number; error: string };

/**
 * Talks to the geometry worker. Only one build runs at a time; while one is running, newer
 * requests replace each other so the worker always jumps to the latest state.
 */
export class BuildClient {
  private worker: Worker;
  private busy = false;
  private pending: BuildRequest | null = null;
  onResult: (r: BuildResult) => void = () => {};
  onError: (id: number, message: string) => void = () => {};
  onFatal: (message: string) => void = () => {};
  onReady: (engine: 'wasm' | 'js') => void = () => {};

  constructor() {
    this.worker = new Worker(new URL('./build.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<Msg>) => this.handle(e.data);
    this.worker.onerror = (e) => this.onFatal(e.message || 'The geometry engine failed to start.');
  }

  private handle(m: Msg) {
    if (m.type === 'ready') return this.onReady(m.engine);
    if (m.type === 'fatal') return this.onFatal(m.error);
    this.busy = false;
    if (m.type === 'result') this.onResult(m.result);
    else this.onError(m.id, m.error);
    if (this.pending) {
      const next = this.pending;
      this.pending = null;
      this.send(next);
    }
  }

  private send(req: BuildRequest) {
    this.busy = true;
    this.worker.postMessage(req);
  }

  request(req: BuildRequest) {
    if (this.busy) this.pending = req;
    else this.send(req);
  }

  get isBusy() {
    return this.busy || !!this.pending;
  }
}
