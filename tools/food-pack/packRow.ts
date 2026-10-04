/**
 * One row of Open Food Facts' export → one food-pack product, or null (Batch UK, 4 Oct 2026). Pure, so it is tested
 * in the app's suite. The cleaning is the server's own (supabase/functions/_shared): the hostile-input pass, the name
 * tidy, the serving parse, the micronutrient keys and the calorie check, so a product in a pack and the same product
 * saved from a scan carry the same values.
 *
 * Kept: a standard barcode with a correct check digit, a name, and complete nutrition per 100 g or 100 ml (calories,
 * protein, carbs, fat). Dropped: anything physically impossible (more than 100 g of a macro per 100 g, macros over
 * 105 g, over 900 kcal), which in crowd-sourced data means a typo, not a food.
 */
import {
  buildOffMicros,
  buildOffServingSizes,
  detectBaseUnit,
  parseOffServing,
  sanitizeCatalogText,
  sanitizeProductName,
  MAX_CATALOG_NAME,
  MAX_CATALOG_BRAND,
} from '../../supabase/functions/_shared/offParsing';
import { sanitizeCalories } from '../../supabase/functions/_shared/nutrientValidation';
import { gtinCheckDigitOk } from '../../supabase/functions/_shared/foodLookup';

/** Bump when the pack's table changes; the app ignores a pack whose schema it doesn't know. */
export const PACK_SCHEMA = 1;

/** The export's columns the build reads (it has 211; checked 4 Oct). Everything else is skipped while streaming. */
export const PACK_COLUMNS = [
  'code', 'product_name', 'brands', 'quantity', 'serving_size', 'serving_quantity', 'countries_tags',
  'categories_tags', 'unique_scans_n',
  'energy-kcal_100g', 'proteins_100g', 'carbohydrates_100g', 'fat_100g', 'fiber_100g', 'saturated-fat_100g',
  'sugars_100g', 'salt_100g', 'sodium_100g',
  'calcium_100g', 'iron_100g', 'magnesium_100g', 'potassium_100g', 'zinc_100g', 'vitamin-a_100g', 'vitamin-c_100g',
  'vitamin-d_100g', 'vitamin-e_100g', 'vitamin-b12_100g', 'vitamin-pp_100g', 'pantothenic-acid_100g',
  'vitamin-b6_100g', 'folates_100g', 'vitamin-b9_100g',
] as const;

export type OffRow = Partial<Record<(typeof PACK_COLUMNS)[number], string>>;

export type PackProduct = {
  barcode: string;
  name: string;
  brand: string | null;
  unit: 'g' | 'ml';
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  satFat: number | null;
  sugars: number | null;
  salt: number | null;
  /** Named portions as JSON, exactly as the catalog stores them (`{"g":100,"serving":30,"slice":30}`). */
  servingSizes: string;
  /** Catalog micro keys, as JSON (`{"calcium_mg":120}`), per 100 g/ml. */
  micros: string;
  /** Open Food Facts' scan count: how often people look this product up. Ranks search and caps big countries. */
  scans: number;
};

/** The table the app reads. WITHOUT ROWID on the barcode: no separate barcode index needed. */
export const PACK_TABLE_SQL = `create table products (
  barcode text primary key,
  name text not null,
  brand text,
  unit text not null check (unit in ('g', 'ml')),
  kcal integer not null,
  protein real not null,
  carbs real not null,
  fat real not null,
  fiber real not null,
  sat_fat real,
  sugars real,
  salt real,
  serving_sizes text not null,
  micros text not null,
  scans integer not null
) without rowid`;

/** A column index for each column the build reads, from the export's header line. */
export function headerIndex(headerLine: string): Map<string, number> {
  const cols = headerLine.replace(/\r$/, '').split('\t');
  const idx = new Map<string, number>();
  for (const name of PACK_COLUMNS) {
    const i = cols.indexOf(name);
    if (i >= 0) idx.set(name, i);
  }
  return idx;
}

/** One export line → the columns the build reads. The export is tab-separated with no quoting (checked 4 Oct). */
export function readRow(line: string, idx: Map<string, number>): OffRow {
  const fields = line.replace(/\r$/, '').split('\t');
  const row: Record<string, string> = {};
  for (const [name, i] of idx) {
    const v = fields[i];
    if (v != null && v !== '') row[name] = v;
  }
  return row as OffRow;
}

/** Whether a row is sold in a country (Open Food Facts' tag, e.g. en:united-kingdom). */
export function soldIn(row: OffRow, countryTag: string): boolean {
  const tags = row.countries_tags;
  return !!tags && tags.split(',').includes(countryTag);
}

const amount = (v: string | undefined): number => {
  if (v == null || v.trim() === '') return Number.NaN;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const optional = (v: string | undefined): number | null => {
  const n = amount(v);
  return Number.isFinite(n) ? round2(n) : null;
};

export function packProductFromRow(row: OffRow): PackProduct | null {
  const barcode = (row.code ?? '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(barcode.length) || !gtinCheckDigitOk(barcode)) return null;

  const declared = amount(row['energy-kcal_100g']);
  const p = amount(row.proteins_100g);
  const c = amount(row.carbohydrates_100g);
  const f = amount(row.fat_100g);
  if (![declared, p, c, f].every(Number.isFinite)) return null;
  if (p > 100 || c > 100 || f > 100 || p + c + f > 105 || declared > 900) return null;

  const rawName = sanitizeCatalogText(row.product_name, MAX_CATALOG_NAME);
  if (!rawName) return null;
  const brand = sanitizeCatalogText((row.brands ?? '').split(',')[0], MAX_CATALOG_BRAND) || null;
  const name = sanitizeProductName(rawName, brand) || rawName;

  const protein = round2(p);
  const carbs = round2(c);
  const fat = round2(f);
  const kcal = sanitizeCalories(declared, protein, carbs, fat);
  if (kcal <= 0 && protein + carbs + fat <= 0) return null;

  const categories = (row.categories_tags ?? '').split(',').filter(Boolean);
  const unit = detectBaseUnit('', row.serving_size, '', row.quantity, categories);
  const serving = parseOffServing(row.serving_size, row.serving_quantity, '', unit);

  const salt = optional(row.salt_100g) ?? (Number.isFinite(amount(row.sodium_100g)) ? round2(amount(row.sodium_100g) * 2.5) : null);
  const scans = Math.max(0, Math.floor(Number(row.unique_scans_n) || 0));

  return {
    barcode,
    name,
    brand,
    unit,
    kcal,
    protein,
    carbs,
    fat,
    fiber: optional(row.fiber_100g) ?? 0,
    satFat: optional(row['saturated-fat_100g']),
    sugars: optional(row.sugars_100g),
    salt,
    servingSizes: JSON.stringify(buildOffServingSizes(serving)),
    micros: JSON.stringify(buildOffMicros(row)),
    scans,
  };
}
