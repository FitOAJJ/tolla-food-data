// Checks each built pack the way the phone will meet it, before the monthly job publishes anything: the file's bytes
// and md5 against the manifest, then opened with SQLite 3.49.1 and the app's own queries run on it (the schema check,
// a search, a barcode lookup). The phone's SQLite is expo-sqlite's bundled 3.50.3
// (node_modules/expo-sqlite/vendor/sqlite3/sqlite3.h); an older reader is the stricter test, so keep the pinned
// @sqlite.org/sqlite-wasm in the workflow at or below the app's version when its Expo SDK changes.
//
//   node tools/food-pack/verifyPack.mjs public/manifest.json
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const EXPECTED_SQLITE = '3.49.1';
const manifestPath = process.argv[2] ?? 'public/manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
const version = sqlite3.version.libVersion;
console.log(`verifying with SQLite ${version}`);
if (version !== EXPECTED_SQLITE) {
  console.error(`expected SQLite ${EXPECTED_SQLITE}, got ${version}: the check would not be the one intended`);
  process.exit(3);
}

// The screens' queries (src/features/nutrition/foodPack/foodPackStore.native.ts).
const SELECT = 'p.barcode, p.name, p.brand, p.unit, p.kcal, p.protein, p.carbs, p.fat';
const SEARCH_SQL = `select ${SELECT} from products_fts f join products p on p.id = f.rowid
  where products_fts match ? order by bm25(products_fts, 10, 4), p.scans desc limit ?`;
const BARCODE_SQL = `select ${SELECT} from products p where p.barcode in (?) limit 1`;

let failed = false;
for (const [country, pack] of Object.entries(manifest.packs ?? {})) {
  try {
    if (pack.files.length !== 1) throw new Error('a pack must be one file');
    const bytes = new Uint8Array(readFileSync(join(dirname(manifestPath), pack.files[0].name)));
    if (bytes.length !== pack.bytes || bytes.length !== pack.files[0].bytes) {
      throw new Error(`${bytes.length} bytes, manifest says ${pack.bytes}`);
    }
    const md5 = createHash('md5').update(bytes).digest('hex');
    if (md5 !== pack.md5 || md5 !== pack.files[0].md5) throw new Error(`md5 ${md5}, manifest says ${pack.md5}`);

    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    const db = new sqlite3.oo1.DB();
    const rc = sqlite3.capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.length, bytes.length,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_READONLY);
    if (rc) throw new Error(`could not open (${rc})`);
    try {
      const schema = db.selectValue("select value from meta where key = 'schema'");
      if (schema !== String(manifest.schema)) throw new Error(`schema ${schema}, manifest says ${manifest.schema}`);
      const count = db.selectValue('select count(*) from products');
      if (count !== pack.products) throw new Error(`${count} products, manifest says ${pack.products}`);
      // Search for a word from the most-scanned product's own name, so this works for a pack in any language.
      const top = db.selectObject('select barcode, name from products order by scans desc limit 1');
      const word = (top?.name ?? '').toLowerCase().match(/\p{L}{3,}/u)?.[0];
      if (!word) throw new Error('the most-scanned product has no word to search for');
      const hits = db.selectObjects(SEARCH_SQL, [`"${word}"*`, 5]);
      if (hits.length === 0) throw new Error(`a search for ${word} found nothing`);
      if (!db.selectObject(BARCODE_SQL, [top.barcode])) throw new Error('barcode lookup failed');
      console.log(`${country}: ok (${count} products, md5 ${md5.slice(0, 8)}; "${word}" → ${hits.map((h) => h.name).slice(0, 3).join(', ')})`);
    } finally {
      db.close();
    }
  } catch (e) {
    failed = true;
    console.error(`${country}: FAILED - ${e.message}`);
  }
}
if (failed) process.exit(3);
