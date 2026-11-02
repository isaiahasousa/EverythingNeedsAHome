/**
 * Filaments are the colours loaded in the printer's AMS, in slot order: slot 1 is index 0. Parts and colour
 * inlays refer to a slot, so changing a slot's colour recolours everything that prints with it.
 */

/** Most AMS setups hold up to 16 spools (four units of four). */
export const MAX_FILAMENTS = 16;

export const PRESET_COLOURS: { name: string; hex: string }[] = [
  { name: 'Teal', hex: '#2f8a87' },
  { name: 'Cobalt', hex: '#2f5fb3' },
  { name: 'Signal orange', hex: '#e8641c' },
  { name: 'Cherry', hex: '#b3263a' },
  { name: 'Sunflower', hex: '#f0bf2c' },
  { name: 'Sage', hex: '#87a07a' },
  { name: 'Lilac', hex: '#9686c4' },
  { name: 'Ivory', hex: '#ece6d6' },
  { name: 'Silver', hex: '#a7aeb4' },
  { name: 'Charcoal', hex: '#34383c' },
];

/** One AMS unit of four. */
export const DEFAULT_FILAMENTS = ['#2f8a87', '#ece6d6', '#f0bf2c', '#34383c'];

/** The colour of `slot`, falling back to slot 1 for a slot that no longer exists. */
export const filamentColour = (filaments: string[], slot: number) => filaments[slot] ?? filaments[0] ?? DEFAULT_FILAMENTS[0];

/** A readable name for a slot, such as "Slot 2 · Ivory". */
export function slotName(filaments: string[], slot: number) {
  const hex = filamentColour(filaments, slot).toLowerCase();
  const preset = PRESET_COLOURS.find((c) => c.hex === hex);
  return `Slot ${slot + 1}${preset ? ` · ${preset.name}` : ''}`;
}
