/// <reference lib="webworker" />
import Module, { type ManifoldToplevel } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { runBuild } from '../geometry/build';
import { setKernel } from '../geometry/kernel';
import type { BuildRequest, BuildResult } from '../core/types';

declare const self: DedicatedWorkerGlobalScope;

type Engine = 'wasm' | 'js';

/**
 * Load the geometry kernel. Native WebAssembly first; if the page's security policy refuses to
 * compile WebAssembly, fall back to the same library translated to plain JavaScript (slower, identical results).
 */
async function loadKernel(): Promise<{ kernel: ManifoldToplevel; engine: Engine }> {
  // The glue reports a refused compile through printErr before throwing; keep that quiet unless both engines fail.
  const quiet: string[] = [];
  try {
    const kernel = await Module({ locateFile: () => wasmUrl, printErr: (m: string) => quiet.push(m) } as unknown as { locateFile: () => string });
    return { kernel, engine: 'wasm' };
  } catch (err) {
    console.info('WebAssembly is blocked here; using the JavaScript geometry engine.', String(err).slice(0, 160));
    const { default: instantiate } = await import('../generated/manifold-fallback.js');
    const kernel = await Module({
      instantiateWasm(info: unknown, receive: (instance: { exports: unknown }) => void) {
        receive({ exports: instantiate(info) });
        return {};
      },
    } as unknown as { locateFile: () => string });
    return { kernel, engine: 'js' };
  }
}

const ready = loadKernel().then(({ kernel, engine }) => {
  kernel.setup();
  setKernel(kernel);
  return engine;
});

ready.then(
  (engine) => self.postMessage({ type: 'ready', engine }),
  (err) => self.postMessage({ type: 'fatal', error: String(err?.message ?? err) }),
);

self.onmessage = async (e: MessageEvent<BuildRequest>) => {
  const req = e.data;
  try {
    await ready;
    const result: BuildResult = runBuild(req);
    const transfer: Transferable[] = [];
    for (const p of result.parts) transfer.push(p.positions.buffer, p.indices.buffer, p.renderPositions.buffer, p.renderNormals.buffer, p.edges.buffer);
    self.postMessage({ type: 'result', result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', id: req.id, error: String((err as Error)?.message ?? err) });
  }
};
