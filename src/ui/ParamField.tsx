import type { BoxParams, ParamDef } from '../core/types';
import { setParam, useProject } from '../state/store';
import { NumberField, Select, Toggle } from './controls';

export function lengthProps(units: 'mm' | 'in', step = 1) {
  return units === 'in'
    ? { scale: 25.4, unit: 'in', decimals: 3, step: step >= 1 ? 0.05 : 0.01 }
    : { scale: 1, unit: 'mm', decimals: 2, step };
}

export function ParamField({ def }: { def: ParamDef }) {
  const value = useProject((p) => p.params[def.key]);
  const units = useProject((p) => p.units);
  const id = `param-${def.key}`;
  const set = (v: BoxParams[typeof def.key]) => setParam(def.key, v as never);
  switch (def.kind) {
    case 'length':
      return <NumberField id={id} label={def.label} value={value as number} min={def.min} max={def.max} help={def.help} onChange={set} {...lengthProps(units, def.step ?? 1)} />;
    case 'number':
      return <NumberField id={id} label={def.label} value={value as number} min={def.min} max={def.max} step={def.step} unit={def.unit} decimals={2} help={def.help} onChange={set} />;
    case 'int':
      return <NumberField id={id} label={def.label} value={value as number} min={def.min} max={def.max} step={1} integer decimals={0} help={def.help} onChange={set} />;
    case 'select':
      return <Select id={id} label={def.label} value={value as string} options={def.options} help={def.help} onChange={set as (v: string) => void} />;
    case 'toggle':
      return <Toggle id={id} label={def.label} checked={value as boolean} help={def.help} onChange={set} />;
  }
}
