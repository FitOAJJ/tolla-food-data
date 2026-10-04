# Tolla food data

Packaged-food nutrition, built once a month from [Open Food Facts](https://world.openfoodfacts.org) for on-phone food search in the Tolla app. It starts with the United Kingdom.

## What is here

- `scripts/`: the build, which reads Open Food Facts' public export and keeps products with a valid barcode, a name and complete nutrition per 100 g or 100 ml.
- `public/`: what the app downloads. One SQLite file per country and a `manifest.json` (month, product count, size, checksum). It is published at `https://foods.tolla.co.uk`.
- `.github/workflows/`: the monthly build.

## Licence and credit

This repository contains information from **Open Food Facts**, made available under the [Open Database License (ODbL) v1.0](https://opendatacommons.org/licenses/odbl/1-0/). Individual contents are under the [Database Contents License](https://opendatacommons.org/licenses/dbcl/1-0/).

The food files in this repository are derived from that database and are likewise made available under the ODbL v1.0. The build code is published so the files can be reproduced. No other licence is granted for it.

Product data is crowd-sourced and may contain errors. It is not medical or dietary advice.
