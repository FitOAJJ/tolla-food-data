/**
 * Open Food Facts serving-data parsing and product-name sanitization.
 *
 * Pure and dependency-free ON PURPOSE: this file is imported by the
 * `food-lookup` Deno edge function AND by node:test suites in
 * `src/features/nutrition/offParsing.test.ts` — no Deno APIs, no imports, so
 * both runtimes agree on it. It lives in `_shared` (the supabase-blessed
 * cross-function location) rather than `src/` because the deploy bundler is
 * only guaranteed to follow imports inside `supabase/functions/`.
 *
 * OFF serving data is crowd-sourced and messy. The three fields, by
 * trustworthiness:
 *   `serving_quantity`       number-ish — the amount in g/ml. Most reliable.
 *   `serving_quantity_unit`  "g" | "ml" when present.
 *   `serving_size`           free text: "1 slice (28g)", "2 biscuits (about
 *                            33 g)", "30 g", "250ml", "33,5 g", "¼ cup (30 g)".
 *                            The only source for the HOUSEHOLD label.
 *
 * The strategy is therefore: take the AMOUNT from `serving_quantity` when it
 * is sane, fall back to the first parseable quantity in the string; take the
 * LABEL only ever from the string; and refuse both rather than guess when
 * nothing parses — a food with no serving data is still loggable in grams.
 */

export type OffServing = {
  /** Total declared serving in `unit`, or null when nothing parseable. */
  amount: number | null;
  unit: 'g' | 'ml';
  /** Household measure ("slice", "biscuit"), singular + snake_case, or null. */
  label: string | null;
  /** How many `label`s make up `amount` (1 unless the string says otherwise). */
  count: number;
};

/** Unicode fractions OFF contributors actually type. */
const FRACTIONS: Record<string, number> = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };

/** "33,5" → 33.5; returns null for anything non-positive or non-finite. */
function toAmount(v: unknown): number | null {
  const n =
    typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace(',', '.')) : NaN;
  // Upper bound: a "serving" above 5 kg/5 L is a data-entry error (weight of a
  // multipack, a barcode, a typo), and writing it would poison the default in
  // the gram stepper.
  return Number.isFinite(n) && n > 0 && n <= 5000 ? n : null;
}

/** Words that are quantities in disguise, not household measures. */
const NON_LABELS = new Set([
  'g', 'gr', 'gram', 'grams', 'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres',
  'oz', 'ounce', 'ounces', 'kg', 'l', 'cl', 'liter', 'litre',
  // Generic container words that would only duplicate the "serving" key.
  'serving', 'servings', 'portion', 'portions', 'part', 'unit', 'units',
]);

/** "250ml", "240 ml", "millilitres" — no \b before "ml": digits and letters
 *  share a word boundary's absence, so "250ml" would slip through a \bml\b. */
const ML_TEXT = /(\d\s*|\b)(ml|cl)\b|millilit/i;

/**
 * The base unit for a product, from every signal OFF offers, most explicit
 * first (a Monster can was ingested as GRAMS because the pre-20.2 function
 * hardcoded 'g' — this chain is the belt-and-braces so that even products with
 * NO serving data resolve correctly):
 *
 *   1. `serving_quantity_unit`  — explicit, when present
 *   2. `serving_size` text      — "500 ml"
 *   3. `product_quantity_unit`  — explicit unit of the PACKAGE size
 *   4. `quantity` text          — "0,5 l", "33 cl", "330ml" vs "200 g"; decisive
 *                                 either way, which is what protects coffee
 *                                 powder and drink mixes: they sit in beverage
 *                                 CATEGORIES but their package is in grams
 *   5. `categories_tags`        — en:beverages ⇒ ml
 *   6. 'g'                      — OFF's per-100 nutriment keys are
 *                                 gram-denominated for solids
 */
export function detectBaseUnit(
  servingQuantityUnit: unknown,
  servingSize: unknown,
  productQuantityUnit: unknown,
  quantity: unknown,
  categoriesTags: unknown,
): 'g' | 'ml' {
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

  const sqUnit = norm(servingQuantityUnit);
  if (sqUnit === 'ml' || sqUnit === 'cl' || sqUnit === 'l') return 'ml';
  if (sqUnit === 'g' || sqUnit === 'kg') return 'g';

  const servingText = norm(servingSize);
  if (ML_TEXT.test(servingText)) return 'ml';
  if (/\d\s*(g|kg)\b/.test(servingText)) return 'g';

  const pqUnit = norm(productQuantityUnit);
  if (pqUnit === 'ml' || pqUnit === 'cl' || pqUnit === 'l') return 'ml';
  if (pqUnit === 'g' || pqUnit === 'kg') return 'g';

  const quantityText = norm(quantity);
  if (/\d\s*(ml|cl|l)\b/.test(quantityText)) return 'ml';
  if (/\d\s*(g|kg)\b/.test(quantityText)) return 'g';

  if (Array.isArray(categoriesTags) && categoriesTags.some((t) => t === 'en:beverages')) {
    return 'ml';
  }
  return 'g';
}

export function parseOffServing(
  servingSize: unknown,
  servingQuantity: unknown,
  servingQuantityUnit: unknown,
  /** Product-level unit (detectBaseUnit) — used when the serving fields are silent. */
  defaultUnit: 'g' | 'ml' = 'g',
): OffServing {
  const text = typeof servingSize === 'string' ? servingSize.trim() : '';

  // ── Unit ── explicit field first; else the string; else the product-level
  // detection the caller resolved.
  const unitField = typeof servingQuantityUnit === 'string' ? servingQuantityUnit.trim().toLowerCase() : '';
  const unit: 'g' | 'ml' =
    unitField === 'ml' ? 'ml'
    : unitField === 'g' ? 'g'
    : ML_TEXT.test(text) ? 'ml'
    : /\d\s*(g|kg)\b/i.test(text) ? 'g'
    : defaultUnit;

  // ── Amount ── the numeric field wins; the string is the fallback. In the
  // string, a parenthesised quantity ("1 slice (28g)") beats a bare one,
  // because the parenthesis is where contributors put the weight.
  let amount = toAmount(servingQuantity);
  if (amount == null && text) {
    const paren = text.match(/\(([^)]*)\)/)?.[1] ?? '';
    const qty = (s: string) => s.match(/([\d]+(?:[.,]\d+)?)\s*(?:g|ml)\b/i)?.[1];
    amount = toAmount(qty(paren) ?? qty(text) ?? null);
  }

  // ── Label + count ── only ever from the text BEFORE the parenthesis (or the
  // whole string when there is none): "2 biscuits (about 33 g)" → 2, biscuits.
  let label: string | null = null;
  let count = 1;
  const head = text.split('(')[0].trim();
  const m = head.match(/^([\d]+(?:[.,]\d+)?|[¼½¾⅓⅔])?\s*([\p{L}][\p{L} ]*)/u);
  if (m) {
    const rawCount = m[1];
    count = rawCount ? FRACTIONS[rawCount] ?? toAmount(rawCount) ?? 1 : 1;
    let word = m[2].trim().toLowerCase();
    // Naive singular for the display key: "slices" → "slice". Guarded so it
    // never mangles short words or double-s endings ("swiss").
    if (count !== 1 && word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
      word = word.slice(0, -1);
    }
    const key = word.replace(/[^\p{L}\p{N}_ ]/gu, '').trim().replace(/\s+/g, '_');
    if (key && !NON_LABELS.has(key)) label = key;
  }

  // A label with no amount is unusable (nothing to convert to grams), and a
  // count needs an amount to divide. Collapse to the honest shape.
  if (amount == null) return { amount: null, unit, label: null, count: 1 };
  return { amount, unit, label, count: count > 0 ? count : 1 };
}

/**
 * OffServing → the catalog's `serving_sizes` JSONB convention
 * (`fdcPortions.buildServingSizes` sets it): the g/oz base pair always present
 * (ml base for drinks), `"serving"` = the total declared serving, and the
 * household measure as grams-per-ONE ("2 biscuits (33g)" → biscuit: 16.5).
 */
export function buildOffServingSizes(serving: OffServing): Record<string, number> {
  const out: Record<string, number> =
    serving.unit === 'ml' ? { ml: 100 } : { g: 100, oz: 28.35 };
  if (serving.amount == null) return out;

  const round = (n: number) => Math.round(n * 100) / 100;
  out.serving = round(serving.amount);
  if (serving.label && !(serving.label in out)) {
    out[serving.label] = round(serving.amount / serving.count);
  }
  return out;
}

/**
 * OFF nutriments → the catalog's `micros` JSONB (2026-08-11 field finding:
 * scans carried macros only, so the accordion and deficiency engine saw
 * nothing from any scanned food).
 *
 * Keys and units MUST match `MICRO_KEYS` in useMicronutrientTargets.ts and the
 * FDC importer's output: `_mg` keys in milligrams, `_mcg` in micrograms, all
 * per 100 g/ml. OFF's `*_100g` values are canonical GRAMS regardless of the
 * label's display unit — verified empirically against a fortified product
 * (calcium_100g 0.12 = the label's 120 mg; vitamin-b12_100g 3.8e-7 = 0.38 µg)
 * — hence the fixed ×1000 / ×1e6 conversions. Values are rounded to 3 dp after
 * conversion, matching the FDC importer's putMicro.
 */
const OFF_MICROS: ReadonlyArray<{ off: string[]; key: string; factor: number }> = [
  // The app's TRACKED ten (MICRO_KEYS) —
  { off: ['calcium_100g'],     key: 'calcium_mg',      factor: 1e3 },
  { off: ['iron_100g'],        key: 'iron_mg',         factor: 1e3 },
  { off: ['magnesium_100g'],   key: 'magnesium_mg',    factor: 1e3 },
  { off: ['potassium_100g'],   key: 'potassium_mg',    factor: 1e3 },
  { off: ['zinc_100g'],        key: 'zinc_mg',         factor: 1e3 },
  { off: ['vitamin-a_100g'],   key: 'vitamin_a_mcg',   factor: 1e6 },
  { off: ['vitamin-c_100g'],   key: 'vitamin_c_mg',    factor: 1e3 },
  { off: ['vitamin-d_100g'],   key: 'vitamin_d_mcg',   factor: 1e6 },
  { off: ['vitamin-e_100g'],   key: 'vitamin_e_mg',    factor: 1e3 },
  { off: ['vitamin-b12_100g'], key: 'vitamin_b12_mcg', factor: 1e6 },
  // — plus label-common nutrients OFF carries that the app does not (yet)
  // track. Stored so the data ACCUMULATES from day one: the accordion and
  // deficiency engine key on MICRO_KEYS and ignore these, so nothing changes
  // user-side, but if the tracked set ever grows, scanned history is already
  // populated instead of needing a backfill. Field-driven (2026-08-11): an
  // energy drink's label listed B3/B5/B6 — none in the tracked ten. `vitamin-pp`
  // is OFF's French-heritage alias for niacin; first present key wins.
  { off: ['sodium_100g'],                          key: 'sodium_mg',      factor: 1e3 },
  { off: ['niacin_100g', 'vitamin-pp_100g'],       key: 'niacin_mg',      factor: 1e3 },
  { off: ['pantothenic-acid_100g'],                key: 'vitamin_b5_mg',  factor: 1e3 },
  { off: ['vitamin-b6_100g'],                      key: 'vitamin_b6_mg',  factor: 1e3 },
  { off: ['folates_100g', 'vitamin-b9_100g'],      key: 'folate_mcg',     factor: 1e6 },
];

export function buildOffMicros(nutriments: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (nutriments == null || typeof nutriments !== 'object') return out;
  const n = nutriments as Record<string, unknown>;
  for (const { off, key, factor } of OFF_MICROS) {
    for (const offKey of off) {
      const raw = n[offKey];
      const grams = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN;
      if (!Number.isFinite(grams) || grams < 0) continue;
      out[key] = Math.round(grams * factor * 1000) / 1000;
      break;
    }
  }
  return out;
}

/**
 * OFF product names, cleaned to sit beside the USDA catalog strings.
 *
 * Deliberately CONSERVATIVE: the failure mode of an aggressive cleaner is
 * destroying meaning ("100% Orange Juice" is a description, "Digestives
 * Original" is a variant), so only three classes of edit are made:
 *
 *  1. Trademark clutter — ™ ® © and their "(TM)"/"(R)" spellings — plus a
 *     SHORT explicit list of purely promotional phrases. Nothing pattern-based.
 *  2. Brand prefix dedupe — "Cadbury Dairy Milk" with brand "Cadbury" becomes
 *     "Dairy Milk": the brand is stored (and searched) in its own column, so
 *     the prefix is duplication, not information.
 *  3. Case — ONLY when the whole name is shouting (ALL CAPS) or whispering
 *     (all lower) is it re-cased to Title Case; legitimate mixed case passes
 *     through untouched.
 *
 * Returns '' when nothing survives — the caller falls back to the raw name,
 * because a cluttered name still beats an empty one.
 */
const PROMO_PHRASES = [
  '100% natural', 'all natural', 'new recipe', 'improved recipe', 'new look',
  'new & improved', 'new and improved', 'now even tastier', 'great taste',
];

/** Words kept lowercase mid-title ("Cream of Mushroom"). */
const SMALL_WORDS = new Set(['a', 'an', 'and', 'de', 'in', 'of', 'or', 'the', 'with']);

/**
 * Hard bounds for catalog strings. `food_items.name` is unbounded `text` with
 * no CHECK, and the name feeds a generated tsvector — so an oversized name
 * bloats the SHARED search index for every user, not just the row.
 */
export const MAX_CATALOG_NAME = 120;
export const MAX_CATALOG_BRAND = 60;

/**
 * Strip anything hostile from a string that is about to enter the SHARED
 * `food_items` catalog (audit MEDIUM — OFF catalog poisoning).
 *
 * Open Food Facts is a world-editable wiki: an attacker needs no account in
 * this app at all. They edit a product's name, and the next Pro user who scans
 * that barcode causes our service-role upsert to write it into the catalog,
 * where it then renders in the scanner result, the food search, the diary
 * timeline and the recipe builder for EVERY user who touches that barcode —
 * and the heal path re-writes it on every refresh, so it persists.
 *
 * React Native `<Text>` does not execute markup, so this is not XSS. It is UI
 * spoofing and layout destruction: a bidi override (U+202E) reverses the
 * rendering of everything after it, control characters and newlines break row
 * layout, and an unbounded string wrecks lists and the search index.
 *
 * `\p{C}` covers control, format (including every bidi override and the
 * zero-width joiners), surrogate, private-use and unassigned code points. Line
 * separators go with them; runs of whitespace collapse to a single space.
 */
export function sanitizeCatalogText(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    // Whitespace FIRST. \p{C} includes newline and tab, so stripping it before
    // this step would JOIN the words either side ("Oat\nMilk" -> "OatMilk")
    // rather than separate them — a word boundary has to survive as a space.
    .replace(/\s/gu, ' ')
    // Now the genuinely invisible classes: control, format (every bidi
    // override, ZWJ/ZWNJ), surrogate, private-use, unassigned.
    .replace(/\p{C}/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();                    // a mid-word cut can leave a trailing space
}

/** Accent-folded lowercase, so "Nestlé" and "Nestle" compare equal. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function sanitizeProductName(rawName: unknown, brand?: string | null): string {
  if (typeof rawName !== 'string') return '';
  // Hostile input first: strip control/bidi/zero-width and bound the length
  // before any of the cosmetic cleaning below runs on it.
  let s = sanitizeCatalogText(rawName, MAX_CATALOG_NAME);

  // 1 — trademark symbols and their ASCII spellings.
  s = s.replace(/[™®©]|\((?:tm|r|c)\)/gi, '');
  for (const phrase of PROMO_PHRASES) {
    s = s.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }

  // 1b — pack sizes are packaging, not food: "Koko Krunch 300g" and
  // "6 x 330 ml" describe the box, and the amount actually eaten is what the
  // gram stepper is for. Multipacks first so their leading count goes too.
  // (Accented-brand field finding, 2026-08-11: both cleanups arrived together.)
  s = s.replace(/\b\d+\s?x\s?\d+(?:[.,]\d+)?\s?(?:g|kg|ml|cl|l)\b\.?/gi, '');
  s = s.replace(/\b\d+(?:[.,]\d+)?\s?(?:g|kg|ml|cl|l)\b\.?/gi, '');

  // 2 — brand prefix dedupe (only when a real name remains without it).
  // Compared accent-FOLDED: OFF routinely has "Nestle …" names under the brand
  // "Nestlé", and a byte-wise compare let the duplication through. Latin
  // accents fold 1:1, so slicing the original by the brand's length is safe.
  const b = brand?.trim();
  if (b && fold(s).startsWith(fold(b))) {
    const rest = s.slice(b.length).replace(/^[\s\-–—:,]+/, '');
    if (rest.length >= 3) s = rest;
  }

  // Tidy what the edits left behind: doubled separators, stray edge punctuation.
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+([,)])/g, '$1')
       .replace(/^[\s\-–—:,]+|[\s\-–—:,!]+$/g, '').trim();

  // 3 — re-case only the shouters and whisperers.
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters && (s === s.toUpperCase() || s === s.toLowerCase())) {
    s = s
      .toLowerCase()
      .split(/\s+/)
      .map((w, i) =>
        i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1),
      )
      .join(' ');
  }
  return s;
}
