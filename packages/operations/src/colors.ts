// SPDX-License-Identifier: BUSL-1.1
/** Stable color identities; concrete values live only in palette definitions. */
export type PaletteColor = { key: string; name: string; value: string; active: boolean };
export type ResolvedColor = PaletteColor & { reference: string; source: 'standard' | 'tenant' };
export const COLOR_SETTINGS_NAMESPACE = 'appearance';
export const COLOR_SETTINGS_KEY = 'colors';
export const COLOR_PALETTE_MAX_COLORS = 100;
export const COLOR_REFERENCE_PATTERN = '^(standard|tenant):[a-z][a-z0-9-]{0,63}$';
export const COLOR_VALUE_PATTERN = '^#[0-9A-Fa-f]{6}$';
export const STANDARD_COLORS: readonly PaletteColor[] = Object.freeze([
  { key: 'crimson', name: 'Crimson', value: '#C51D48', active: true },
  { key: 'violet', name: 'Violet', value: '#6541AC', active: true },
  { key: 'ocean', name: 'Ocean', value: '#175BAA', active: true },
  { key: 'forest', name: 'Forest', value: '#22724F', active: true },
  { key: 'dark', name: 'Dark', value: '#111111', active: true },
  { key: 'royal', name: 'Royal', value: '#5347CD', active: true },
  { key: 'cobalt', name: 'Cobalt', value: '#2563EB', active: true },
  { key: 'white', name: 'White', value: '#FFFFFF', active: true },
  { key: 'ink', name: 'Ink', value: '#111827', active: true },
  { key: 'blue', name: 'Blue', value: '#78A5DA', active: true },
  { key: 'indigo', name: 'Indigo', value: '#7E8ED3', active: true },
  { key: 'green', name: 'Green', value: '#2ED3A3', active: true },
  { key: 'orange', name: 'Orange', value: '#F99167', active: true },
  { key: 'red', name: 'Red', value: '#FF7F9A', active: true },
  { key: 'purple', name: 'Purple', value: '#A47AD1', active: true },
  { key: 'neutral', name: 'Neutral', value: '#3A4254', active: true },
]);
export function parseTenantColors(value: unknown): PaletteColor[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'colors')) throw new Error('Invalid color palette.');
  const colors = (value as { colors?: unknown }).colors;
  if (!Array.isArray(colors) || colors.length > COLOR_PALETTE_MAX_COLORS) throw new Error(`A palette contains at most ${COLOR_PALETTE_MAX_COLORS} colors.`);
  const keys = new Set<string>();
  return colors.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['key','name','value','active'].includes(key)) ||
      typeof item.key !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(item.key) || keys.has(item.key) ||
      typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 ||
      typeof item.value !== 'string' || !new RegExp(COLOR_VALUE_PATTERN).test(item.value) || typeof item.active !== 'boolean') throw new Error('Invalid or duplicate palette color.');
    keys.add(item.key);
    return { key: item.key, name: item.name.trim(), value: item.value.toUpperCase(), active: item.active };
  });
}
export function resolvePalette(tenantColors: readonly PaletteColor[]): ResolvedColor[] {
  return [ ...STANDARD_COLORS.map(color => ({ ...color, reference: `standard:${color.key}`, source: 'standard' as const })),
    ...tenantColors.map(color => ({ ...color, reference: `tenant:${color.key}`, source: 'tenant' as const })) ];
}
export function resolveColor(reference: unknown, palette: readonly ResolvedColor[]): ResolvedColor | undefined {
  return typeof reference === 'string' ? palette.find(color => color.reference === reference) : undefined;
}
