import { useState } from 'react';
import { DEFAULT_FILAMENTS, MAX_FILAMENTS, PRESET_COLOURS, slotName } from '../core/filaments';
import { addFilament, removeFilament, setFilament, useProject } from '../state/store';
import { Swatches } from './controls';

/** Black or white, whichever reads better on `hex`. */
export function inkOn(hex: string) {
  const v = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (v >> 16) + 0.587 * ((v >> 8) & 0xff) + 0.114 * (v & 0xff)) / 255;
  return lum > 0.6 ? '#15191c' : '#ffffff';
}

function SlotChip({ slot, pressed, onClick, label }: { slot: number; pressed: boolean; onClick: () => void; label?: string }) {
  const filaments = useProject((p) => p.filaments);
  const hex = filaments[slot];
  return (
    <button type="button" className="slot" style={{ background: hex, color: inkOn(hex) }} aria-pressed={pressed} title={slotName(filaments, slot)} aria-label={label ?? slotName(filaments, slot)} onClick={onClick}>
      {slot + 1}
    </button>
  );
}

/** Choose one of the AMS slots. */
export function SlotPicker({ value, onChange, label }: { value: number; onChange: (slot: number) => void; label: string }) {
  const count = useProject((p) => p.filaments.length);
  return (
    <div className="slot-picker" role="group" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <SlotChip key={i} slot={i} pressed={i === value} onClick={() => onChange(i)} />
      ))}
    </div>
  );
}

/** The filaments loaded in the AMS, in slot order: pick a slot to change its colour; add or remove slots. */
export function FilamentPalette() {
  const filaments = useProject((p) => p.filaments);
  const [open, setOpen] = useState(0);
  const slot = Math.min(open, filaments.length - 1);
  const add = () => {
    const next = [...DEFAULT_FILAMENTS, ...PRESET_COLOURS.map((c) => c.hex)].find((c) => !filaments.includes(c)) ?? '#ffffff';
    addFilament(next);
    setOpen(filaments.length);
  };
  return (
    <div className="palette">
      <div className="slot-picker" role="group" aria-label="AMS slots">
        {filaments.map((_, i) => (
          <SlotChip key={i} slot={i} pressed={i === slot} label={`Edit ${slotName(filaments, i)}`} onClick={() => setOpen(i)} />
        ))}
        {filaments.length < MAX_FILAMENTS && (
          <button type="button" className="slot add" title="Add a slot" aria-label="Add a filament slot" onClick={add}>
            +
          </button>
        )}
      </div>
      <div className="palette-edit">
        <span className="field-help" style={{ margin: 0 }}>
          {slotName(filaments, slot)}: the filament loaded in AMS slot {slot + 1}.
        </span>
        <Swatches label={`Slot ${slot + 1} colour`} value={filaments[slot]} colors={PRESET_COLOURS} onChange={(hex) => setFilament(slot, hex)} />
        {filaments.length > 1 && (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              removeFilament(slot);
              setOpen(Math.max(0, slot - 1));
            }}
          >
            Remove slot {slot + 1}
          </button>
        )}
      </div>
    </div>
  );
}
