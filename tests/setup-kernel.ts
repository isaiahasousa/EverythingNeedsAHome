import Module from 'manifold-3d';
import { setKernel } from '../src/geometry/kernel';

let ready: Promise<void> | null = null;
export function loadKernel() {
  if (!ready)
    ready = (async () => {
      const wasm = await Module();
      wasm.setup();
      setKernel(wasm);
    })();
  return ready;
}
