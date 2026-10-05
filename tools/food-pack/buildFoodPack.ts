/**
 * The monthly food-pack build (Batch UK, 4 Oct 2026). Reads Open Food Facts' full export as it downloads (about
 * 1.28 GB compressed; never stored whole), keeps each listed country's products with complete nutrition (packRow.ts),
 * and writes one SQLite file per country plus manifest.json for the app. Runs in the public data repo's scheduled
 * job (FitOAJJ/tolla-food-data); Cloudflare Pages serves the result at https://foods.tolla.co.uk.
 *
 *   npx tsx tools/food-pack/buildFoodPack.ts --countries gb --out public [--source <url|file.gz>] [--month YYYY-MM]
 *       [--cap 250000] [--force]
 *
 * Safety: a pack whose product count falls below 90 % of last month's fails the build (exit 2) and last month's file
 * stays live, unless --force. Each pack is ONE file of at most 24 MiB (Cloudflare Pages serves 25 MiB a file): the
 * least-scanned products are left out until it fits, so the phone never joins parts. The search index is built here
 * (hotfix, 4 Oct: joining and indexing on the phone crashed the app), so the phone only downloads, checks and opens.
 * Since Batch UK2 (5 Oct) it is a plain word index (packWords.ts), not FTS5: the phone's first FTS5 search crashed it.
 * File names carry the build (`foods-gb-202610-<first 8 of the md5>.db`): the files are cached for a year, so a rebuild
 * within a month never reuses a name.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { PACK_COUNTRIES, isPackCountry, type PackCountry } from './countries';
import { PACK_SCHEMA, PACK_TABLE_SQL, headerIndex, packProductFromRow, readRow, soldIn, type PackProduct } from './packRow';
import { PACK_POSTINGS_SQL, PACK_VOCAB_SQL, productWords } from '../../src/features/nutrition/foodPack/packWords';

export const OFF_EXPORT_URL = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz';
export const USER_AGENT = 'Tolla/1.1 (support@tolla.co.uk)';
/** Cloudflare Pages' per-file limit is 25 MiB; every pack fits under this, in one file. */
export const MAX_FILE_BYTES = 24 * 1024 * 1024;
export const MIN_RATIO = 0.9;

export type ManifestFile = { name: string; bytes: number; md5: string };
export type ManifestPack = { month: string; products: number; bytes: number; md5: string; files: ManifestFile[] };
export type Manifest = { schema: number; generated: string; source: string; licence: string; packs: Record<string, ManifestPack> };

type Args = { countries: PackCountry[]; out: string; source: string; month: string; cap: number; force: boolean; maxBytes?: number };

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const countries = (get('--countries') ?? 'gb').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  for (const c of countries) if (!isPackCountry(c)) throw new Error(`unknown country: ${c}`);
  const month = get('--month') ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('--month must be YYYY-MM');
  return {
    countries: countries as PackCountry[],
    out: get('--out') ?? 'public',
    source: get('--source') ?? OFF_EXPORT_URL,
    month,
    cap: Number(get('--cap') ?? 250_000),
    force: argv.includes('--force'),
  };
}

const md5Of = (buf: Buffer) => createHash('md5').update(buf).digest('hex');

async function openLines(source: string) {
  const raw = /^https?:\/\//.test(source)
    ? await fetch(source, { headers: { 'User-Agent': USER_AGENT } }).then((res) => {
        if (!res.ok || !res.body) throw new Error(`export download failed: HTTP ${res.status}`);
        return Readable.fromWeb(res.body as never);
      })
    : createReadStream(source);
  return createInterface({ input: raw.pipe(createGunzip()), crlfDelay: Infinity });
}

/** Keep the `cap` most-scanned products when a country has more (big markets stay a phone-sized download). */
function capByScans(db: DatabaseSync, cap: number): number {
  const total = Number((db.prepare('select count(*) as n from products').get() as { n: number }).n);
  if (total <= cap) return 0;
  db.exec(`delete from products where barcode not in (select barcode from products order by scans desc, barcode limit ${Math.floor(cap)})`);
  return total - cap;
}

/** Builds the word index from the products that are left: each word once in vocab, each product it's in in postings. */
function indexWords(db: DatabaseSync): void {
  db.exec('delete from postings; delete from vocab;');
  const ids = new Map<string, number>();
  const addWord = db.prepare('insert into vocab (word, id) values (?, ?)');
  const addPosting = db.prepare('insert into postings (word_id, product_id, in_name) values (?, ?, ?)');
  db.exec('begin');
  for (const p of db.prepare('select id, name, brand from products').iterate() as Iterable<{ id: number; name: string; brand: string | null }>) {
    for (const [word, inName] of productWords(p.name, p.brand)) {
      let id = ids.get(word);
      if (id === undefined) {
        id = ids.size + 1;
        ids.set(word, id);
        addWord.run(word, id);
      }
      addPosting.run(id, p.id, inName);
    }
  }
  db.exec('commit');
}

/** Builds the word index and compacts the file. */
function finish(db: DatabaseSync): void {
  indexWords(db);
  db.exec('vacuum');
}

/** Stops the build if the file or the word index isn't sound (every posting points at a word and a product). */
function checkPack(db: DatabaseSync, c: string): void {
  const one = (sql: string) => Object.values(db.prepare(sql).get() as Record<string, unknown>)[0];
  const integrity = one('pragma integrity_check');
  if (integrity !== 'ok') throw new Error(`${c}: integrity check: ${String(integrity)}`);
  const orphans = Number(one(`select count(*) from postings x where not exists (select 1 from products p where p.id = x.product_id)
    or not exists (select 1 from vocab v where v.id = x.word_id)`));
  if (orphans !== 0) throw new Error(`${c}: ${orphans} index entries point at nothing`);
  const dupes = Number(one('select count(*) - count(distinct id) from vocab'));
  if (dupes !== 0) throw new Error(`${c}: ${dupes} repeated word ids`);
}

/** Leaves out the least-scanned products, 5 % at a time, until the file fits in one piece. Returns how many went. */
function fitToSize(db: DatabaseSync, path: string, maxBytes: number): number {
  let dropped = 0;
  for (let round = 0; readFileSync(path).length > maxBytes; round++) {
    if (round > 40) throw new Error('the pack could not be made small enough');
    const n = Number((db.prepare('select count(*) as n from products').get() as { n: number }).n);
    const drop = Math.max(1, Math.ceil(n * 0.05));
    db.exec(`delete from products where id in (select id from products order by scans asc, id desc limit ${drop})`);
    dropped += drop;
    finish(db);
  }
  return dropped;
}

export async function buildFoodPacks(args: Args): Promise<Manifest> {
  mkdirSync(args.out, { recursive: true });
  const manifestPath = join(args.out, 'manifest.json');
  const previous: Manifest | null = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const stamp = args.month.replace('-', '');

  // One database per country, filled in a single pass over the export.
  const dbs = new Map<PackCountry, { db: DatabaseSync; insert: ReturnType<DatabaseSync['prepare']>; path: string; kept: number }>();
  for (const c of args.countries) {
    const path = join(args.out, `.building-${c}.db`);
    if (existsSync(path)) rmSync(path);
    const db = new DatabaseSync(path);
    db.exec('pragma journal_mode = off; pragma synchronous = off;');
    db.exec(PACK_TABLE_SQL);
    db.exec(PACK_VOCAB_SQL);
    db.exec(PACK_POSTINGS_SQL);
    db.exec('create table meta (key text primary key, value text not null)');
    const insert = db.prepare(`insert or ignore into products (barcode, name, brand, unit, kcal, protein, carbs, fat, scans)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.exec('begin');
    dbs.set(c, { db, insert, path, kept: 0 });
  }

  const lines = await openLines(args.source);
  let idx: Map<string, number> | null = null;
  let rows = 0;
  let rejected = 0;
  for await (const line of lines) {
    if (!idx) {
      idx = headerIndex(line);
      for (const need of ['code', 'product_name', 'countries_tags', 'energy-kcal_100g', 'proteins_100g', 'carbohydrates_100g', 'fat_100g']) {
        if (!idx.has(need)) throw new Error(`the export has no ${need} column: its format changed`);
      }
      continue;
    }
    rows++;
    const row = readRow(line, idx);
    if (!row.countries_tags) continue;
    let product: PackProduct | null | undefined;
    for (const [c, t] of dbs) {
      if (!soldIn(row, PACK_COUNTRIES[c].tag)) continue;
      if (product === undefined) product = packProductFromRow(row);
      if (!product) { rejected++; break; }
      t.insert.run(product.barcode, product.name, product.brand, product.unit, product.kcal, product.protein,
        product.carbs, product.fat, product.scans);
      t.kept++;
      if (t.kept % 10_000 === 0) { t.db.exec('commit'); t.db.exec('begin'); }
    }
  }
  if (!idx) throw new Error('the export was empty');

  const manifest: Manifest = {
    schema: PACK_SCHEMA,
    generated: new Date().toISOString(),
    source: 'Open Food Facts export',
    licence: 'ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/)',
    // Packs from an older schema aren't carried over: the app version that reads them is a different one.
    packs: previous?.schema === PACK_SCHEMA ? { ...previous.packs } : {},
  };
  const failures: string[] = [];
  /** This build's files: everything else of these countries is removed once the manifest is written. */
  const built: string[] = [];
  for (const [c, t] of dbs) {
    t.db.exec('commit');
    const capped = capByScans(t.db, args.cap);
    finish(t.db);
    const trimmed = fitToSize(t.db, t.path, args.maxBytes ?? MAX_FILE_BYTES);
    checkPack(t.db, c);
    const dropped = capped + trimmed;
    const products = Number((t.db.prepare('select count(*) as n from products').get() as { n: number }).n);
    const meta = t.db.prepare('insert into meta (key, value) values (?, ?)');
    for (const [k, v] of [['schema', String(PACK_SCHEMA)], ['country', c], ['month', args.month], ['products', String(products)],
      ['source', 'Open Food Facts (ODbL 1.0)'], ['generated', manifest.generated]]) meta.run(k, v);
    t.db.close();

    const last = previous?.packs?.[c];
    if (last && products < last.products * MIN_RATIO && !args.force) {
      failures.push(`${c}: ${products} products, under ${Math.round(MIN_RATIO * 100)} % of last month's ${last.products}`);
      rmSync(t.path);
      continue;
    }
    if (products === 0) { failures.push(`${c}: no products`); rmSync(t.path); continue; }

    const whole = readFileSync(t.path);
    const wholeMd5 = md5Of(whole);
    const baseName = `foods-${c}-${stamp}-${wholeMd5.slice(0, 8)}.db`;
    const finalPath = join(args.out, baseName);
    if (existsSync(finalPath)) rmSync(finalPath);
    writeFileSync(finalPath, whole);
    rmSync(t.path);
    const files: ManifestFile[] = [{ name: baseName, bytes: whole.length, md5: wholeMd5 }];
    built.push(baseName);
    manifest.packs[c] = { month: args.month, products, bytes: whole.length, md5: wholeMd5, files };
    console.log(`${c}: ${products} products${dropped ? ` (${dropped} least-scanned left out)` : ''}, ${(whole.length / 1048576).toFixed(1)} MB in one file`);
  }
  console.log(`read ${rows} export rows; ${rejected} in-country rows rejected (incomplete or impossible nutrition, bad barcode, no name)`);
  if (failures.length > 0) {
    // The manifest is left as it was, so the app keeps last month's packs.
    throw Object.assign(new Error(`build stopped: ${failures.join('; ')}`), { exitCode: 2 });
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // Only now, with every country passed and the manifest written: this month's files replace the older ones.
  for (const c of args.countries) {
    for (const f of readdirSync(args.out)) if (f.startsWith(`foods-${c}-`) && !built.includes(f)) rmSync(join(args.out, f));
  }
  return manifest;
}

if (process.argv[1] && /buildFoodPack\.ts$/.test(process.argv[1])) {
  buildFoodPacks(parseArgs(process.argv.slice(2))).catch((e: Error & { exitCode?: number }) => {
    console.error(e.message);
    process.exit(e.exitCode ?? 1);
  });
}

