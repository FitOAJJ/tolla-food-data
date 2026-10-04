/**
 * The countries a food pack can be built for (Batch UK, 4 Oct 2026): ISO 3166 code → Open Food Facts' country tag.
 * The monthly build makes the packs its `--countries` list names (the United Kingdom first); the app picks the pack
 * for the phone's region setting, and Settings can choose another.
 */
export const PACK_COUNTRIES = {
  gb: { tag: 'en:united-kingdom', name: 'United Kingdom' },
  ie: { tag: 'en:ireland', name: 'Ireland' },
  us: { tag: 'en:united-states', name: 'United States' },
  ca: { tag: 'en:canada', name: 'Canada' },
  au: { tag: 'en:australia', name: 'Australia' },
  fr: { tag: 'en:france', name: 'France' },
  de: { tag: 'en:germany', name: 'Germany' },
  es: { tag: 'en:spain', name: 'Spain' },
  it: { tag: 'en:italy', name: 'Italy' },
  nl: { tag: 'en:netherlands', name: 'Netherlands' },
} as const;

export type PackCountry = keyof typeof PACK_COUNTRIES;

export function isPackCountry(code: string): code is PackCountry {
  return Object.prototype.hasOwnProperty.call(PACK_COUNTRIES, code);
}
