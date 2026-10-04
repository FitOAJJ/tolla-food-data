// Opens each built pack with the phone's own SQLite version and runs what the app runs (the schema check, a search,
// a barcode lookup). The monthly job runs this before publishing, so a file the phone can't read never goes live.
// The version is expo-sqlite's bundled SQLite (node_modules/expo-sqlite/vendor/sqlite3/sqlite3.h): keep the pinned
// @sqlite.org/sqlite-wasm in the workflow in step with it when the app's Expo SDK changes.
//
//   node tools/food-pack/verifyPack.mjs public/manifest.json
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const manifestPath = process.argv[2] ?? 'public/manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
console.log(`verifying with SQLite ${sqlite3.version.libVersion}`);

let failed = false;
for (const [country, pack] of Object.entries(manifest.packs ?? {})) {
  try {
    if (pack.files.length !== 1) throw new Error('a pack must be one file');
    const bytes = new Uint8Array(readFileSync(join(dirname(manifestPath), pack.files[0].name)));
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    const db = new sqlite3.oo1.DB();
    const rc = sqlite3.capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.length, bytes.length,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_READONLY);
    if (rc) throw new Error(`could not open (${rc})`);
    const schema = db.selectValue("select value from meta where key = 'schema'");
    if (schema !== String(manifest.schema)) throw new Error(`schema ${schema}, manifest says ${manifest.schema}`);
    const count = db.selectValue('select count(*) from products');
    if (count !== pack.products) throw new Error(`${count} products, manifest says ${pack.products}`);
    const hits = db.selectObjects(`select p.name from products_fts f join products p on p.id = f.rowid
      where products_fts match ? order by bm25(products_fts, 10, 4), p.scans desc limit 5`, ['"milk"*']);
    if (hits.length === 0) throw new Error('a search for milk found nothing');
    const barcode = db.selectValue('select barcode from products order by scans desc limit 1');
    if (!db.selectValue('select name from products where barcode = ?', [barcode])) throw new Error('barcode lookup failed');
    console.log(`${country}: ok (${count} products; "milk" → ${hits.map((h) => h.name).slice(0, 3).join(', ')})`);
    db.close();
  } catch (e) {
    failed = true;
    console.error(`${country}: FAILED - ${e.message}`);
  }
}
if (failed) process.exit(3);
