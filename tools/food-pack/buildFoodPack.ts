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
 * stays live, unless --force. A file over 24 MiB is split into parts (Cloudflare Pages serves at most 25 MiB a file).
 * File names carry the build (`foods-gb-202610-<first 8 of the md5>.db`): the files are cached for a year, so a rebuild
 * within a month never reuses a name.
 * The search index is not in the file: the phone builds it after download, which keeps the download small.
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

export const OFF_EXPORT_URL = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz';
export const USER_AGENT = 'Tolla/1.1 (support@tolla.co.uk)';
/** Cloudflare Pages' per-file limit is 25 MiB; parts stay under this. */
export const PART_BYTES = 24 * 1024 * 1024;
export const MIN_RATIO = 0.9;

export type ManifestFile = { name: string; bytes: number; md5: string };
export type ManifestPack = { month: string; products: number; bytes: number; md5: string; files: ManifestFile[] };
export type Manifest = { schema: number; generated: string; source: string; licence: string; packs: Record<string, ManifestPack> };

type Args = { countries: PackCountry[]; out: string; source: string; month: string; cap: number; force: boolean };

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

function splitIntoParts(path: string, baseName: string, out: string): ManifestFile[] {
  const buf = readFileSync(path);
  if (buf.length <= PART_BYTES) {
    return [{ name: baseName, bytes: buf.length, md5: md5Of(buf) }];
  }
  rmSync(path);
  const files: ManifestFile[] = [];
  for (let off = 0, n = 1; off < buf.length; off += PART_BYTES, n++) {
    const part = buf.subarray(off, Math.min(off + PART_BYTES, buf.length));
    const name = `${baseName}.part${n}`;
    writeFileSync(join(out, name), part);
    files.push({ name, bytes: part.length, md5: md5Of(part) });
  }
  return files;
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
    db.exec('create table meta (key text primary key, value text not null)');
    const insert = db.prepare(`insert or ignore into products
      (barcode, name, brand, unit, kcal, protein, carbs, fat, fiber, sat_fat, sugars, salt, serving_sizes, micros, scans)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
        product.carbs, product.fat, product.fiber, product.satFat, product.sugars, product.salt, product.servingSizes,
        product.micros, product.scans);
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
    packs: { ...(previous?.packs ?? {}) },
  };
  const failures: string[] = [];
  /** This build's files: everything else of these countries is removed once the manifest is written. */
  const built: string[] = [];
  for (const [c, t] of dbs) {
    t.db.exec('commit');
    const dropped = capByScans(t.db, args.cap);
    const products = Number((t.db.prepare('select count(*) as n from products').get() as { n: number }).n);
    const meta = t.db.prepare('insert into meta (key, value) values (?, ?)');
    for (const [k, v] of [['schema', String(PACK_SCHEMA)], ['country', c], ['month', args.month], ['products', String(products)],
      ['source', 'Open Food Facts (ODbL 1.0)'], ['generated', manifest.generated]]) meta.run(k, v);
    t.db.exec('vacuum');
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
    const files = splitIntoParts(finalPath, baseName, args.out);
    built.push(...files.map((f) => f.name));
    manifest.packs[c] = { month: args.month, products, bytes: whole.length, md5: wholeMd5, files };
    console.log(`${c}: ${products} products${dropped ? ` (${dropped} least-scanned left out)` : ''}, ${(whole.length / 1048576).toFixed(1)} MB in ${files.length} file(s)`);
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

