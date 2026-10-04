// Barcode forms and the two lookup sources (Batch Y, worldwide foods, 3 Oct 2026). A leaf module with no imports:
// food-lookup (Deno) uses all of it, the app uses the barcode half, and the unit tests import it directly.

// ── Barcode forms ────────────────────────────────────────────────────────────────────────────────────────────────

/** GS1 mod-10 check: the last digit matches the rest (weights 3, 1, 3… from the right). */
export function gtinCheckDigitOk(code: string): boolean {
  if (!/^\d{8,14}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * A UPC-E code (8 digits: number system 0 or 1, six digits, check) written out as the 12-digit UPC-A it stands for.
 * Shops and databases file products under the UPC-A, so a scanned UPC-E is expanded before any lookup. Returns null
 * for anything that isn't a valid UPC-E.
 */
export function expandUpcE(code: string): string | null {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0];
  const d = code.slice(1, 7);
  const check = code[7];
  const last = Number(d[5]);
  let body: string;
  if (last <= 2) body = `${d[0]}${d[1]}${d[5]}0000${d[2]}${d[3]}${d[4]}`;
  else if (last === 3) body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  else if (last === 4) body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  else body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${d[5]}`;
  const upcA = `${ns}${body}${check}`;
  return gtinCheckDigitOk(upcA) ? upcA : null;
}

/**
 * The forms one product's barcode can be filed under, the scanned form first. A 12-digit UPC-A is the same product
 * as the 13-digit EAN with a leading 0 and the 14-digit GTIN with two (USDA files Diet Coke as 00049000028911, not
 * 049000028911; Open Food Facts answers either). Six at most, digits only.
 */
export function barcodeVariants(code: string): string[] {
  const c = (code ?? '').replace(/\D/g, '');
  if (!/^\d{6,14}$/.test(c)) return [];
  const out = [c];
  if (c.length === 8) out.push(`000000${c}`);
  if (c.length === 12) out.push(`0${c}`, `00${c}`);
  if (c.length === 13) out.push(c.startsWith('0') ? c.slice(1) : '', `0${c}`);
  if (c.length === 14) {
    if (c.startsWith('00')) out.push(c.slice(2), c.slice(1));
    else if (c.startsWith('0')) out.push(c.slice(1));
  }
  return [...new Set(out.filter(Boolean))].slice(0, 6);
}

// ── Open Food Facts ──────────────────────────────────────────────────────────────────────────────────────────────

export type SourceOutcome = 'ok' | 'not-found' | 'unavailable';

/**
 * What an Open Food Facts product response means. Found: HTTP 200 with status 1. Not found: status 0 (an unknown
 * code comes back as HTTP 200 or 404 with status 0, checked 3 Oct). Anything else (a refusal, a server error, a
 * timeout, an HTML error page) is "unavailable": the product may well exist, so it is never remembered as missing.
 */
export function classifyOffResponse(httpStatus: number | null, body: unknown): SourceOutcome {
  if (httpStatus == null || httpStatus === 429 || httpStatus >= 500) return 'unavailable';
  if (body == null || typeof body !== 'object') return 'unavailable';
  const b = body as { status?: unknown; product?: unknown };
  if (b.status === 1 && b.product && typeof b.product === 'object') return 'ok';
  if (b.status === 0 || httpStatus === 404) return 'not-found';
  return 'unavailable';
}

/**
 * A refusal, a block or an overloaded server means "back off": every lookup to that source pauses for a while.
 * (A 403 from Open Food Facts is most likely a block of the shared server address.)
 */
export function shouldCoolDown(httpStatus: number | null): boolean {
  return httpStatus === 429 || httpStatus === 503 || httpStatus === 403;
}

// ── USDA FoodData Central (branded) ──────────────────────────────────────────────────────────────────────────────

/** One search query for every form of the barcode: `gtinUpc:A OR gtinUpc:B …` (checked against the API, 3 Oct). */
export function usdaGtinQuery(variants: readonly string[]): string {
  return variants.filter((v) => /^\d{6,14}$/.test(v)).map((v) => `gtinUpc:${v}`).join(' OR ');
}

/** The subset of a FoodData Central search hit the lookup reads. */
export type UsdaFood = {
  fdcId?: number;
  description?: unknown;
  brandName?: unknown;
  brandOwner?: unknown;
  gtinUpc?: unknown;
  servingSize?: unknown;
  servingSizeUnit?: unknown;
  householdServingFullText?: unknown;
  foodNutrients?: Array<{ nutrientId?: unknown; value?: unknown }>;
};

/** The hit whose barcode is exactly one of ours (a search can return near misses), else null. */
export function pickUsdaFood(foods: unknown, variants: readonly string[]): UsdaFood | null {
  if (!Array.isArray(foods)) return null;
  const want = new Set(variants);
  for (const f of foods) {
    const g = typeof f?.gtinUpc === 'string' ? f.gtinUpc.replace(/\D/g, '') : '';
    if (g && want.has(g)) return f as UsdaFood;
  }
  return null;
}

/** FoodData Central nutrient ids (per 100 g or 100 ml for branded foods), the same ids as scripts/importFDC.ts. */
const USDA = {
  calories: 1008, protein: 1003, fat: 1004, carbs: 1005, fiber: 1079,
  calcium: 1087, iron: 1089, magnesium: 1090, potassium: 1092, zinc: 1095, sodium: 1093,
  vitaminA: 1106, vitaminE: 1109, vitaminC: 1162, vitaminB12: 1178, vitaminD: 1114, vitaminDiu: 1110,
  niacin: 1167, vitaminB6: 1175, folate: 1177, vitaminB5: 1170,
} as const;

/** Micro keys and units match the catalog's (`_mg` in mg, `_mcg` in µg, per 100 g/ml), as buildOffMicros writes them. */
const USDA_MICROS: ReadonlyArray<[keyof typeof USDA, string]> = [
  ['calcium', 'calcium_mg'], ['iron', 'iron_mg'], ['magnesium', 'magnesium_mg'], ['potassium', 'potassium_mg'],
  ['zinc', 'zinc_mg'], ['vitaminA', 'vitamin_a_mcg'], ['vitaminC', 'vitamin_c_mg'], ['vitaminE', 'vitamin_e_mg'],
  ['vitaminB12', 'vitamin_b12_mcg'], ['sodium', 'sodium_mg'], ['niacin', 'niacin_mg'], ['vitaminB6', 'vitamin_b6_mg'],
  ['vitaminB5', 'vitamin_b5_mg'], ['folate', 'folate_mcg'],
];

export type UsdaNutrients = {
  /** As declared (0 when absent); the caller runs the Atwater check. */
  declaredKcal: number;
  protein: number; carbs: number; fat: number; fiber: number;
  micros: Record<string, number>;
};

const pos = (v: unknown): number => {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function usdaNutrients(food: UsdaFood): UsdaNutrients {
  const by = new Map<number, number>();
  for (const fn of Array.isArray(food.foodNutrients) ? food.foodNutrients : []) {
    const id = typeof fn?.nutrientId === 'number' ? fn.nutrientId : Number(fn?.nutrientId);
    if (Number.isFinite(id)) by.set(id, pos(fn.value));
  }
  const micros: Record<string, number> = {};
  for (const [k, key] of USDA_MICROS) {
    const v = by.get(USDA[k]);
    if (v && v > 0) micros[key] = Math.round(v * 1000) / 1000;
  }
  const d = by.get(USDA.vitaminD) || ((by.get(USDA.vitaminDiu) ?? 0) / 40);
  if (d > 0) micros.vitamin_d_mcg = Math.round(d * 1000) / 1000;
  return {
    declaredKcal: by.get(USDA.calories) ?? 0,
    protein: by.get(USDA.protein) ?? 0,
    carbs: by.get(USDA.carbs) ?? 0,
    fat: by.get(USDA.fat) ?? 0,
    fiber: by.get(USDA.fiber) ?? 0,
    micros,
  };
}

/**
 * The declared serving in the shape parseOffServing reads: "1 can (355 ml)", 355, "ml". USDA writes units as
 * g / GRM and ml / MLT. Nulls when USDA gives no serving.
 */
export function usdaServing(food: UsdaFood): { text: string; quantity: number | null; unit: 'g' | 'ml' } {
  const rawUnit = typeof food.servingSizeUnit === 'string' ? food.servingSizeUnit.trim().toLowerCase() : '';
  const unit: 'g' | 'ml' = rawUnit === 'ml' || rawUnit === 'mlt' ? 'ml' : 'g';
  const quantity = pos(food.servingSize) || null;
  const household = typeof food.householdServingFullText === 'string' ? food.householdServingFullText.trim() : '';
  const text = quantity ? `${household || 'serving'} (${quantity} ${unit})` : household;
  return { text, quantity, unit };
}
