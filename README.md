# Tolla food data

Packaged-food nutrition, built once a month from [Open Food Facts](https://world.openfoodfacts.org) for on-phone food search in the Tolla app. It starts with the United Kingdom.

## What is here

- `tools/food-pack/`: the build. It reads Open Food Facts' public export as it downloads and keeps each country's products that have a valid barcode, a name and complete nutrition per 100 g or 100 ml.
- `supabase/functions/_shared/`: the Tolla server's own cleaning code (names, servings, nutrients, the calorie check), so a product in a pack matches the same product scanned in the app. Copied from the app's repository, which is the source of truth.
- `site/`: the two small files published with the packs.
- `.github/workflows/food-packs.yml`: the monthly build. It publishes this month's files on the `pages` branch, which Cloudflare Pages serves at `https://foods.tolla.co.uk`, and keeps every month as a release.

What the app downloads: one SQLite file per country (`foods-gb-YYYYMM-<build>.db`, where the build is the first 8 characters of its md5, split into parts over 24 MiB) and `manifest.json` (month, product count, size, checksum). The files are cached for a year, so every build gets new names.

Run it yourself (Node 24): `npx tsx tools/food-pack/buildFoodPack.ts --countries gb --out public`. It downloads the full export (about 1.28 GB).

## Licence and credit

This repository contains information from **Open Food Facts**, made available under the [Open Database License (ODbL) v1.0](https://opendatacommons.org/licenses/odbl/1-0/). Individual contents are under the [Database Contents License](https://opendatacommons.org/licenses/dbcl/1-0/).

The food files in this repository are derived from that database and are likewise made available under the ODbL v1.0. The build code is published so the files can be reproduced. No other licence is granted for it.

Product data is crowd-sourced and may contain errors. It is not medical or dietary advice.
