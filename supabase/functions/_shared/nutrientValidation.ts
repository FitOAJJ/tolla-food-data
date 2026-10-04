/**
 * Validation for crowd-contributed label nutrients (`food-contribute`).
 *
 * Pure and Deno-free — imported by the edge function AND tested from `src`
 * under node:test, same arrangement as `offParsing.ts`.
 *
 * THE RULE: fill-empty-only. A contribution may only add what the row does not
 * have; anything that would overwrite an existing value REJECTS THE WHOLE
 * PAYLOAD (409 upstream) rather than silently skipping fields — a contributor
 * should know their numbers were refused, not wonder which half landed.
 *
 *  · Micros: per-key. A key already present in the row's `micros` JSONB is
 *    occupied — even at 0, because the OFF pipeline writes explicit zeros only
 *    when the source declared them.
 *  · Macros: all-or-nothing. The columns are NOT NULL, so "empty" cannot mean
 *    null — it means the row carries no nutritional information at all
 *    (calories, protein, carbs, fat, fiber ALL zero). Only then may the block
 *    be filled, only as a complete block, validated against the Atwater
 *    identity like every other macro source in the app.
 *  · An ALL-ZERO macro payload is rejected as nothing-to-contribute (review
 *    finding): writing zeros onto a zero block is a no-op that would leave the
 *    block reading as "still empty" — the one state where first-writer-wins
 *    could not hold, since the next contributor could "fill" it again.
 */

/**
 * Contributable micro keys → hard per-100g ceilings (sanity bounds, not DRIs).
 * A plain literal so `keyof typeof MICRO_CEILINGS` is the key union — the
 * client derives its form fields from these keys, which is what keeps the
 * offer-list and the accept-list from drifting.
 */
export const MICRO_CEILINGS = {
  // The tracked ten (MICRO_KEYS) —
  calcium_mg: 2500,       // hard cheeses ~1200; leave headroom for concentrates
  iron_mg: 100,           // fortified cereals ~60
  magnesium_mg: 1000,     // pumpkin seeds ~590
  potassium_mg: 20000,    // salt substitutes (KCl) genuinely reach ~13000
  zinc_mg: 200,           // oysters ~60
  vitamin_a_mcg: 30000,   // liver ~9000
  vitamin_c_mg: 3000,     // acerola powder ~1700
  vitamin_d_mcg: 300,     // fortified oils
  vitamin_e_mg: 300,      // wheat-germ oil ~150
  vitamin_b12_mcg: 500,   // liver ~80
  // — plus the extended captured set (parity with buildOffMicros).
  sodium_mg: 40000,       // table salt IS ~39000 per 100 g
  niacin_mg: 2000,
  vitamin_b5_mg: 1000,
  vitamin_b6_mg: 1000,
  folate_mcg: 5000,
} as const;

export type ContributableMicroKey = keyof typeof MICRO_CEILINGS;

/** Macro bounds per 100 g/ml. Fat's Atwater max is the calorie ceiling.
 *  Exported for the client form's per-field clamps — same table both sides. */
export const MACRO_BOUNDS = {
  calories: 900, protein: 100, carbs: 100, fat: 100, fiber: 80,
} as const;

/**
 * Atwater coefficients + the label tolerance, exported as THE shared copy —
 * `food-lookup`'s ingest gate consumes these. ARCHITECTURE_STATE records that
 * duplicate Atwater validators were deleted once already because the copies
 * drifted to different tolerances; the scanner and the contribution gate must
 * accept the same numbers.
 */
export const ATWATER = { protein: 4, carbs: 4, fat: 9 } as const;
export function atwaterTolerance(theoreticalKcal: number): number {
  return Math.max(15, theoreticalKcal * 0.15);
}

/**
 * Calories to trust for a label: the declared value when it matches the macros (within atwaterTolerance), else the
 * Atwater yield. One copy, used by food-lookup's scan path and the food-pack build (Batch UK), so a product saved
 * from a scan and the same product in a pack carry the same number.
 */
export function sanitizeCalories(declared: number, protein: number, carbs: number, fat: number): number {
  const theoretical = protein * ATWATER.protein + carbs * ATWATER.carbs + fat * ATWATER.fat;
  const delta = Math.abs((declared || 0) - theoretical);
  return delta <= atwaterTolerance(theoretical) && declared > 0
    ? Math.round(declared)
    : Math.round(theoretical);
}

export type MacroBlock = { calories: number; protein: number; carbs: number; fat: number; fiber: number };

/**
 * "This row carries no macro information." Shared client/server so the form's
 * offer and the server's acceptance cannot disagree. Values pass through
 * Number() because PostgREST returns Postgres `numeric` columns as STRINGS —
 * hence the `number | string` typing; do not "simplify" the coercion away.
 */
export function macroBlockEmpty(row: {
  calories: number | string; protein: number | string; carbs: number | string;
  fat: number | string; fiber: number | string;
}): boolean {
  return (
    Number(row.calories) === 0 && Number(row.protein) === 0 && Number(row.carbs) === 0 &&
    Number(row.fat) === 0 && Number(row.fiber) === 0
  );
}

export type ExistingRow = {
  calories: number | string;
  protein: number | string;
  carbs: number | string;
  fat: number | string;
  fiber: number | string;
  micros: Record<string, number> | null;
};

export type ContributionPayload = {
  macros?: MacroBlock;
  micros?: Record<string, number>;
};

export type ValidationResult =
  | { ok: true; microUpdates: Record<string, number>; macroUpdates: MacroBlock | null }
  | { ok: false; code: 'empty' | 'overwrite' | 'bounds' | 'atwater'; fields: string[] };

const bad = (v: unknown): boolean => typeof v !== 'number' || !Number.isFinite(v) || v < 0;

export function validateContribution(
  existing: ExistingRow,
  payload: ContributionPayload,
): ValidationResult {
  const microsIn = payload.micros ?? {};
  const microKeys = Object.keys(microsIn);
  let wantsMacros = payload.macros != null;

  // An all-zero macro block contributes nothing AND would leave the block
  // still reading "empty" — refuse it so occupancy stays meaningful.
  if (wantsMacros && macroBlockEmpty(payload.macros!)) wantsMacros = false;
  if (!wantsMacros && microKeys.length === 0) return { ok: false, code: 'empty', fields: [] };

  // ── Fill-empty-only ── every violation is collected, then the WHOLE payload
  // is rejected: partial application would leave the contributor guessing.
  const occupied: string[] = [];
  const existingMicros = existing.micros ?? {};
  for (const key of microKeys) {
    if (key in existingMicros) occupied.push(key);
  }
  if (wantsMacros && !macroBlockEmpty(existing)) occupied.push('macros');
  if (occupied.length > 0) return { ok: false, code: 'overwrite', fields: occupied };

  // ── Bounds ──
  const outOfBounds: string[] = [];
  const microUpdates: Record<string, number> = {};
  for (const key of microKeys) {
    const ceiling = (MICRO_CEILINGS as Record<string, number>)[key];
    const value = microsIn[key];
    if (ceiling == null || bad(value) || value > ceiling) { outOfBounds.push(key); continue; }
    microUpdates[key] = Math.round(value * 1000) / 1000;
  }
  if (wantsMacros) {
    for (const [key, max] of Object.entries(MACRO_BOUNDS)) {
      const value = (payload.macros as unknown as Record<string, number>)[key];
      if (bad(value) || value > max) outOfBounds.push(key);
    }
  }
  if (outOfBounds.length > 0) return { ok: false, code: 'bounds', fields: outOfBounds };

  // ── Atwater identity ── same tolerance the scanner applies to labels, but
  // checked against THREE carb bases (review finding: wheat bran's honest
  // label failed the naive P·4+C·4+F·9 by 140 kcal). Labels genuinely differ:
  // US carbs INCLUDE fiber, EU carbs EXCLUDE it, and fiber itself is often
  // counted at ~2 kcal/g. A declared value consistent with ANY of the three
  // is a real label, not a typo.
  if (wantsMacros) {
    const m = payload.macros!;
    const pf = m.protein * ATWATER.protein + m.fat * ATWATER.fat;
    const bases = [
      pf + m.carbs * ATWATER.carbs,                             // US: fiber inside carbs at 4
      pf + Math.max(0, m.carbs - m.fiber) * ATWATER.carbs,      // EU: carbs exclude fiber
      pf + Math.max(0, m.carbs - m.fiber) * ATWATER.carbs + m.fiber * 2, // fiber at 2 kcal/g
    ];
    const consistent = bases.some((t) => Math.abs(m.calories - t) <= atwaterTolerance(t));
    if (!consistent) return { ok: false, code: 'atwater', fields: ['calories'] };
  }

  return { ok: true, microUpdates, macroUpdates: wantsMacros ? payload.macros! : null };
}
