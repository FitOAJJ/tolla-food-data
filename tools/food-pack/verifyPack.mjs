// Checks each built pack the way the phone will meet it, before the monthly job publishes anything: the file's bytes
// and md5 against the manifest, then opened with the phone's own SQLite version (expo-sqlite bundles 3.50.3:
// node_modules/expo-sqlite/vendor/sqlite3/sqlite3.h) to run the app's own search and barcode queries. The queries are
// imported from the app's packWords.ts (Node runs TypeScript directly), not copied, so this checks what ships.
// Keep the pinned @sqlite.org/sqlite-wasm in the workflow at the app's version when its Expo SDK changes.
//
//   node tools/food-pack/verifyPack.mjs public/manifest.json
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { packBarcodeSql, packSearch, packWords } from '../../src/features/nutrition/foodPack/packWords.ts';

const EXPECTED_SQLITE = '3.50.3';
const manifestPath = process.argv[2] ?? 'public/manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
const version = sqlite3.version.libVersion;
console.log(`verifying with SQLite ${version}`);
if (version !== EXPECTED_SQLITE) {
  console.error(`expected SQLite ${EXPECTED_SQLITE} (the phone's), got ${version}: the check would not be the one intended`);
  process.exit(3);
}

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
      const ok = db.selectValue('pragma quick_check');
      if (ok !== 'ok') throw new Error(`quick check: ${ok}`);

      // Searches built from the most-scanned product's own name, so this works for a pack in any language: its first
      // word (must find it), that word's first two letters, its first two words, and the word with a last single letter
      // (the heaviest search the app runs: every word starting with that letter).
      const top = db.selectObject('select barcode, name from products order by scans desc limit 1');
      const words = packWords(top?.name).filter((w) => w.length >= 2);
      if (words.length === 0) throw new Error('the most-scanned product has no word to search for');
      const queries = [words[0], words[0].slice(0, 2), words.slice(0, 2).join(' '), `${words[0]} ${words[0][0]}`];
      const report = [];
      for (const q of queries) {
        const s = packSearch(q, 25);
        const t = performance.now();
        const hits = db.selectObjects(s.sql, s.params);
        report.push(`"${q}" ${hits.length} in ${Math.round(performance.now() - t)} ms`);
        if (hits.length === 0) throw new Error(`a search for "${q}" found nothing`);
      }
      if (!db.selectObject(packBarcodeSql(1), [top.barcode])) throw new Error('barcode lookup failed');
      console.log(`${country}: ok (${count} products, md5 ${md5.slice(0, 8)}; ${report.join('; ')})`);
    } finally {
      db.close();
    }
  } catch (e) {
    failed = true;
    console.error(`${country}: FAILED - ${e.message}`);
  }
}
if (failed) process.exit(3);
