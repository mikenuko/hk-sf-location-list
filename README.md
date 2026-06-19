# SF HK Pickup Locations

Latest **SF Express Hong Kong** service points as static **JSON + GeoJSON**, refreshed daily by a **self-hosted GitHub Actions runner** that writes the files to a local directory on the runner's own server (`$DEPLOY_DIR`, default `/srv/sfhk/data`). The committed `data/` folder *is* the API; the server directory is the published copy. No UI, no GitHub Pages, no Docker required.

## Data

| File | What |
|------|------|
| `data/locations.json` | All outlets (flat array) |
| `data/locations.csv` | Same as a spreadsheet (UTF-8 BOM; opens in Excel) |
| `data/by-district/<district>.json` | One file per HK district |
| `data/locations.geojson` | GeoJSON `FeatureCollection` (if you ever want it on a map) |
| `data/meta.json` | Version, counts, capability breakdown, district index, hash |
| `data/changelog.json` | `added` / `removed` / `changed` ids vs. the previous run |

### Outlet shape

```jsonc
{
  "code": "852DDL",   // SF location code
  "id": "852DDL",     // unique key (= code, suffixed only on rare collisions)
  "name_en": "...", "name_tc": "...",
  "address_en": "...", "address_tc": "...",
  "telephone": "...",
  "hours_en": "...", "hours_tc": "...",
  "lat": 22.45, "lng": 114.16,
  "district": "Tai Po District", "sub_district": "Tai Po",
  "type": "station",          // station | partner | locker
  "bizTypeCode": "1,3,5,6,7",
  "cold_chain": true
}
```

> **On `type`:** the upstream `queryServiceNetworkList` endpoint returns `storeType: null` and `bizTypeCode` is only a *capability* set, so `type` is derived: **locker** when the name is an `SF Locker`, **partner** for convenience/cooperation shops (便利店, OK, VanGO, Circle K, individual stores…), otherwise **station** (manned SF stores, which carry the `5`/`1` service flags). `cold_chain` = bizTypeCode contains `1`. Current split: ~301 station / ~617 partner / ~764 locker.

## How it works

`src/fetch.mjs` drives a real Chrome (Playwright) to `hk.sf-express.com/hk/en/store` and calls the gateway in-page — required because a Huawei WAF blocks non-browser TLS fingerprints. It iterates all 21 HK districts (a flat query is capped at 1000; the true total is ~1,684) in EN and TC, then `src/build.mjs` normalizes, diffs against the last snapshot, applies a >20%-drop guardrail, and writes `data/`.

## Run locally

```bash
npm ci
npx playwright install chromium   # or rely on installed Google Chrome (default channel)
npm run refresh                    # writes data/
```

`HEADED=1` to watch the browser; `PW_CHANNEL=chromium` to use Playwright's bundled Chromium instead of system Chrome.

## Schedule & deploy

`.github/workflows/refresh.yml` runs daily (~04:17 HKT) on a **self-hosted runner** (`runs-on: [self-hosted, sfhk]`). It installs Chromium per run, rebuilds `data/`, commits only when something changed (audit trail), then **rsyncs the JSON to `$DEPLOY_DIR`** (a local path on the runner's own server). Running on an HK IP also clears the SF Huawei WAF more reliably than cloud runners.

The deploy is just a local file copy — whatever consumes the data reads it straight off disk:

```
$DEPLOY_DIR/locations.json          # all outlets (flat array)
$DEPLOY_DIR/by-district/<d>.json    # one file per HK district
$DEPLOY_DIR/meta.json               # version, counts, hash, district index
```

**Setup:** see [`deploy/README.md`](deploy/README.md) for the self-hosted runner install, host prerequisites, and where the files land.
