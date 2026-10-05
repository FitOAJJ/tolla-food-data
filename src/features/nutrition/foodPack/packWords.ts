/**
 * The food pack's word index (Batch UK2, 5 Oct 2026), shared by the monthly build (tools/food-pack), the phone's
 * search and the build's pre-publish check, so all three split words and search exactly the same way. A leaf module
 * with no imports: the build runs it in Node and the data repo copies it as is (tools/food-pack/syncDataRepo.mjs).
 *
 * Why not FTS5: the phone aborted the app (native SIGABRT, 4 and 5 Oct) the first time it ran an FTS5 search, or the
 * close straight after it, while the same queries on the same file ran cleanly in SQLite 3.50.3 on a PC. The word
 * index uses only what Tolla's other stores already do on the phone every day: ordinary tables, indexed lookups, joins.
 */

/** A typed word this long or longer counts as a whole word: exact matches rank first ("milk" before "Milka"). */
export const EXACT_MIN_LETTERS = 3;
export const MAX_QUERY_WORDS = 6;

/**
 * Lowercase, accents off ("Crème" → "creme"), compatibility forms folded (ligatures, full-width letters), split on
 * anything that isn't a letter or digit.
 */
export function packWords(text: string | null | undefined): string[] {
  return (text ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * One product's index entries: each word once, 1 when it's in the name (a brand-only word ranks lower). Single
 * letters are indexed too, so "kellogg's", "vitamin c" and "M&M's" find their products (review, 5 Oct).
 */
export function productWords(name: string, brand: string | null): Array<[string, 0 | 1]> {
  const seen = new Map<string, 0 | 1>();
  for (const w of packWords(name)) seen.set(w, 1);
  for (const w of packWords(brand)) if (!seen.has(w)) seen.set(w, 0);
  return [...seen];
}

/** Every word with its id, keyed by the word so a prefix is a range lookup. */
export const PACK_VOCAB_SQL = 'create table vocab (word text primary key, id integer not null) without rowid';
/** Which products each word is in. Keyed by word, so one word's products sit together. */
export const PACK_POSTINGS_SQL = `create table postings (
  word_id integer not null,
  product_id integer not null,
  in_name integer not null,
  primary key (word_id, product_id)
) without rowid`;

/** The columns a search or a barcode lookup returns (PackFood in packCore). */
export const PACK_SELECT = 'p.barcode, p.name, p.brand, p.unit, p.kcal, p.protein, p.carbs, p.fat';

/** Above every character a word can hold, so `word <= prefix + TOP` ends a prefix's range. */
const TOP = '\u{10FFFF}';

/** The words a search uses: at most 6. Null when there's under 2 letters in all. */
export function queryWords(text: string): string[] | null {
  const words = packWords(text).slice(0, MAX_QUERY_WORDS);
  return words.join('').length < 2 ? null : words;
}

/**
 * The search for `n` words. Every word matches as a prefix and all must match, except a single letter before the
 * last word, which matches only itself (the "s" of "kellogg's", the "m" of "M&M's": as a prefix it would match every
 * word starting with it). Ranked by whole-word matches (words of 3+ letters), then matches in the name rather than
 * only the brand, then how often people scan the product. For each word the best way the product matches it counts
 * (a whole word in the name, then a whole word in the brand, then part of a word in the name, then in the brand).
 * Parameters per word, in order: its position, the word for the whole-word test ('' when it's under 3 letters), the
 * range start, the range end; then the number of words and the limit. Plain `?` placeholders, bound in order, as the
 * app's other queries are.
 */
export function packSearchSql(n: number): string {
  const one = `select ? as qi, x.product_id, (v.word = ?) * 2 + x.in_name as how
    from vocab v join postings x on x.word_id = v.id where v.word between ? and ?`;
  return `with m as (${Array.from({ length: n }, () => one).join(' union all ')}),
  per as (select qi, product_id, max(how) as best from m group by qi, product_id),
  s as (select product_id, count(*) as hit, sum(best >= 2) as exacts, sum(best % 2) as names from per group by product_id)
  select ${PACK_SELECT} from s join products p on p.id = s.product_id
  where s.hit = ? order by s.exacts desc, s.names desc, p.scans desc limit ?`;
}

/** The search's SQL and parameters for what's typed, or null when there's nothing to search. */
export function packSearch(text: string, limit: number): { sql: string; params: Array<string | number> } | null {
  const words = queryWords(text);
  if (!words) return null;
  const params: Array<string | number> = [];
  words.forEach((w, i) => {
    const onlyItself = w.length === 1 && i < words.length - 1;
    params.push(i, w.length >= EXACT_MIN_LETTERS ? w : '', w, onlyItself ? w : w + TOP);
  });
  params.push(words.length, limit);
  return { sql: packSearchSql(words.length), params };
}

/** The barcode lookup for `n` forms of one barcode (foodLookup's barcodeVariants). */
export function packBarcodeSql(n: number): string {
  return `select ${PACK_SELECT} from products p where p.barcode in (${Array.from({ length: n }, () => '?').join(', ')}) limit 1`;
}
