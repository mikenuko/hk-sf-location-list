# SF HK Pickup Locations

Latest **SF Express Hong Kong** service points as static **JSON + GeoJSON**, refreshed daily by GitHub Actions. No runtime server — the committed `data/` folder *is* the API.

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
  "bizTypeCode": "1,3,5,6,7",
  "services": ["1","3","5","6","7"],
  "is_station": true, "is_locker": true, "is_partner": false, "cold_chain": true
}
```

> **On `type`:** the upstream `queryServiceNetworkList` endpoint returns `storeType: null` and `bizTypeCode` is a *capability* set, not a clean physical type. The `is_*` flags mirror SF's own "Service Point Type" dropdown (Station = `1|4`, Locker = `6`, Partner = `8|9|10`) but overlap heavily. EF Lockers appear to be a **separate feed** not covered here — a candidate for a future source.

## How it works

`src/fetch.mjs` drives a real Chrome (Playwright) to `hk.sf-express.com/hk/en/store` and calls the gateway in-page — required because a Huawei WAF blocks non-browser TLS fingerprints. It iterates all 21 HK districts (a flat query is capped at 1000; the true total is ~1,684) in EN and TC, then `src/build.mjs` normalizes, diffs against the last snapshot, applies a >20%-drop guardrail, and writes `data/`.

## Run locally

```bash
npm ci
npx playwright install chromium   # or rely on installed Google Chrome (default channel)
npm run refresh                    # writes data/
```

`HEADED=1` to watch the browser; `PW_CHANNEL=chromium` to use Playwright's bundled Chromium instead of system Chrome.

## Schedule & serving

`.github/workflows/refresh.yml` runs daily (~04:17 HKT), installs Chromium in the runner, rebuilds `data/`, commits only when something changed, then **publishes to GitHub Pages**. The runner having no browser pre-installed is irrelevant — Playwright installs one per run.

The published site is a searchable, sortable **list** (filter by code/name/address, district, or type) with the data files at the root:

```
https://<user>.github.io/<repo>/                  # searchable list (site/index.html)
https://<user>.github.io/<repo>/locations.csv     # spreadsheet
https://<user>.github.io/<repo>/locations.json
https://<user>.github.io/<repo>/by-district/<district>.json
https://<user>.github.io/<repo>/meta.json
```

**One-time setup:** repo **Settings → Pages → Source → GitHub Actions**. After that every refresh redeploys automatically.
