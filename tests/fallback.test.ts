import { describe, expect, it } from 'vitest';
import Module from 'manifold-3d';
import { BOX_TYPES, DEFAULT_PARAMS } from '../src/boxes';
import { releaseAll, setKernel } from '../src/geometry/kernel';
import type { BoxParams } from '../src/core/types';

import fs from 'node:fs';

const path = process.env.FALLBACK ?? new URL('../src/generated/manifold-fallback.js', import.meta.url).pathname;

describe.skipIf(!fs.existsSync(path))('pure-JS geometry engine (wasm2js)', () => {
  it('builds every box type and matches the WASM volumes', async () => {
    const instantiate = (await import(/* @vite-ignore */ path!)).default;
    const t0 = performance.now();
    const js = await Module({
      instantiateWasm(info: unknown, receive: (inst: unknown) => void) {
        receive({ exports: instantiate(info) });
        return {};
      },
    } as never);
    js.setup();
    console.log('fallback load ms', (performance.now() - t0).toFixed(0));
    const native = await Module();
    native.setup();
    for (const id of Object.keys(BOX_TYPES) as (keyof typeof BOX_TYPES)[]) {
      const t = BOX_TYPES[id];
      const p = { ...DEFAULT_PARAMS } as BoxParams;
      const R = t.resolve(p);
      const vols: number[][] = [];
      const times: number[] = [];
      for (const k of [native, js]) {
        setKernel(k);
        const s = performance.now();
        const parts = t.build(p, R);
        times.push(performance.now() - s);
        vols.push(Object.values(parts).map((m) => m.volume()));
        releaseAll();
      }
      console.log(id.padEnd(11), 'wasm', times[0].toFixed(0).padStart(5), 'ms   js', times[1].toFixed(0).padStart(5), 'ms');
      vols[0].forEach((v, i) => expect(vols[1][i]).toBeCloseTo(v, 3));
    }
  });
});
