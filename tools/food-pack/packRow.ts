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
  detectBaseUnit,
  sanitizeCatalogText,
  sanitizeProductName,
  MAX_CATALOG_NAME,
  MAX_CATALOG_BRAND,
} from '../../supabase/functions/_shared/offParsing';
import { sanitizeCalories } from '../../supabase/functions/_shared/nutrientValidation';
import { gtinCheckDigitOk } from '../../supabase/functions/_shared/foodLookup';

/**
 * Bump when the pack's table changes; the app ignores a pack whose schema it doesn't know. 2 (hotfix, 4 Oct): slim
 * columns and the search index built here, not on the phone (schema 1's on-phone join and index build crashed the app).
 */
export const PACK_SCHEMA = 2;

/** The export's columns the build reads (it has 211; checked 4 Oct). Everything else is skipped while streaming. */
export const PACK_COLUMNS = [
  'code', 'product_name', 'brands', 'quantity', 'serving_size', 'serving_quantity', 'countries_tags',
  'categories_tags', 'unique_scans_n',
  'energy-kcal_100g', 'proteins_100g', 'carbohydrates_100g', 'fat_100g',
] as const;

export type OffRow = Partial<Record<(typeof PACK_COLUMNS)[number], string>>;

/**
 * What search shows, and nothing more: logging a product saves the full food through Tolla's server (servings,
 * fiber, micronutrients come from there), so the pack stays a small single download.
 */
export type PackProduct = {
  barcode: string;
  name: string;
  brand: string | null;
  unit: 'g' | 'ml';
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Open Food Facts' scan count: how often people look this product up. Ranks search and decides what's kept. */
  scans: number;
};

/** The table the app reads (a rowid table, so the search index can point into it without copying the text). */
export const PACK_TABLE_SQL = `create table products (
  id integer primary key,
  barcode text not null unique,
  name text not null,
  brand text,
  unit text not null check (unit in ('g', 'ml')),
  kcal integer not null,
  protein real not null,
  carbs real not null,
  fat real not null,
  scans integer not null
)`;

/**
 * The search index, built by the job (checked readable by SQLite 3.49.1, the phone's version, 4 Oct). External
 * content: the index points at products' rows instead of storing the text again. detail=column keeps it small and
 * still supports single-word and prefix matches with per-column weights.
 */
export const PACK_FTS_SQL = `create virtual table products_fts using fts5(
  name, brand, content = 'products', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2', detail = 'column'
)`;

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
  // All zeros is a real label (water, diet drinks, black coffee): kept, as the scan path keeps it.
  const kcal = sanitizeCalories(declared, protein, carbs, fat);

  const categories = (row.categories_tags ?? '').split(',').filter(Boolean);
  const unit = detectBaseUnit('', row.serving_size, '', row.quantity, categories);
  const scans = Math.max(0, Math.floor(Number(row.unique_scans_n) || 0));

  return { barcode, name, brand, unit, kcal, protein, carbs, fat, scans };
}
