import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchOutlets } from './fetch.mjs';

const DATA = fileURLToPath(new URL('../data/', import.meta.url));
const SNAPSHOT = DATA + '.snapshot.json';
const MIN_RETAIN = 0.8; // abort publish if outlet count drops below 80% of last run

// Physical type. storeType is null and bizTypeCode is a capability set, so we
// classify from the name — lockers and convenience/partner shops name themselves
// — with a bizTypeCode fallback: unmanned cooperation points lack both the "5"
// (manned SF store) and "1" (cold-chain station) service flags.
const LOCKER = /\bSF\s*Locker\b|順豐智能櫃|智能櫃|Cold\s*Chain\s*Locker|EF\s*Locker/i;
const PARTNER = /便利店|Conv\.|\bOK\b|VanGO|Circle\s?K|U\s?Select|U購|7-?Eleven|阿信屋|\b759\b|Indiv\.?\s?Store|Individual\s*Store|個體店|士多/i;
function classify(r) {
  const name = `${r.name_en || ''} ${r.name_tc || ''}`;
  const set = new Set(String(r.bizTypeCode || '').split(',').map((s) => s.trim()).filter(Boolean));
  let type;
  if (LOCKER.test(name)) type = 'locker';
  else if (PARTNER.test(name)) type = 'partner';
  else if (!set.has('5') && !set.has('1')) type = 'partner';
  else type = 'station';
  return { type, cold_chain: set.has('1') };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function normalize(rows) {
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    let id = r.id || `${r.lng},${r.lat}`;
    if (seen.has(id)) id = `${id}-${seen.get(id) + 1}`; // keep both on rare code collisions
    seen.set(r.id, (seen.get(r.id) || 0) + 1);
    out.push({
      code: r.id, // SF location code, e.g. "852DDL"
      id,
      name_en: r.name_en, name_tc: r.name_tc,
      address_en: r.address_en, address_tc: r.address_tc,
      telephone: r.telephone || null,
      hours_en: r.serviceTime_en || null, hours_tc: r.serviceTime_tc || null,
      lat: r.lat, lng: r.lng,
      district: r.city, district_tc: r.city_tc || null,
      sub_district: r.district, sub_district_tc: r.district_tc || null,
      bizTypeCode: r.bizTypeCode,
      ...classify(r),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const toGeoJSON = (rows) => ({
  type: 'FeatureCollection',
  features: rows.map((r) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
    properties: { ...r, lat: undefined, lng: undefined },
  })),
});

const CSV_COLS = ['code', 'name_en', 'name_tc', 'address_en', 'address_tc', 'telephone',
  'hours_en', 'hours_tc', 'lat', 'lng', 'district', 'district_tc', 'sub_district', 'sub_district_tc',
  'type', 'bizTypeCode', 'cold_chain'];
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCSV = (rows) =>
  '﻿' + [CSV_COLS.join(',')] // BOM so Excel reads UTF-8 (Chinese) correctly
    .concat(rows.map((r) => CSV_COLS.map((c) => csvCell(r[c])).join(',')))
    .join('\r\n');

function diff(prev, next) {
  const pj = new Map(prev.map((r) => [r.id, JSON.stringify(r)]));
  const nj = new Map(next.map((r) => [r.id, JSON.stringify(r)]));
  const added = [...nj.keys()].filter((id) => !pj.has(id));
  const removed = [...pj.keys()].filter((id) => !nj.has(id));
  const changed = [...nj.keys()].filter((id) => pj.has(id) && pj.get(id) !== nj.get(id));
  return { added, removed, changed };
}

const count = (rows, pred) => rows.filter(pred).length;

async function main() {
  console.log('Fetching SF HK service points…');
  const { sourceVersion, tcPatched, rows } = await fetchOutlets({ headless: process.env.HEADED !== '1' });
  const data = normalize(rows);
  console.log(`Fetched ${data.length} outlets (source ${sourceVersion}, ${tcPatched} with TC).`);

  const prev = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, 'utf8')) : [];
  if (prev.length && data.length < prev.length * MIN_RETAIN) {
    throw new Error(`Guardrail: ${data.length} outlets < ${MIN_RETAIN * 100}% of previous ${prev.length}. Aborting publish.`);
  }

  // Fresh data dir (keeps removed district files from lingering).
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA + 'by-district', { recursive: true });

  const json = JSON.stringify(data, null, 2);
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 12);
  writeFileSync(DATA + 'locations.json', json);
  writeFileSync(DATA + 'locations.csv', toCSV(data));
  writeFileSync(DATA + 'locations.geojson', JSON.stringify(toGeoJSON(data)));

  const districts = [...new Set(data.map((r) => r.district))].sort();
  for (const d of districts) {
    writeFileSync(DATA + `by-district/${slug(d)}.json`, JSON.stringify(data.filter((r) => r.district === d)));
  }

  const changelog = diff(prev, data);
  writeFileSync(DATA + 'changelog.json', JSON.stringify({ generated_at: new Date().toISOString(), ...changelog }, null, 2));
  writeFileSync(SNAPSHOT, json);

  const meta = {
    generated_at: new Date().toISOString(),
    source_version: sourceVersion,
    hash,
    count: data.length,
    tc_coverage: count(data, (r) => r.name_tc) / data.length,
    type_counts: {
      station: count(data, (r) => r.type === 'station'),
      partner: count(data, (r) => r.type === 'partner'),
      locker: count(data, (r) => r.type === 'locker'),
      cold_chain: count(data, (r) => r.cold_chain),
    },
    districts: Object.fromEntries(districts.map((d) => [d, count(data, (r) => r.district === d)])),
    changes: { added: changelog.added.length, removed: changelog.removed.length, changed: changelog.changed.length },
    files: {
      all: 'locations.json',
      csv: 'locations.csv',
      geojson: 'locations.geojson',
      by_district: districts.map((d) => `by-district/${slug(d)}.json`),
      changelog: 'changelog.json',
    },
  };
  writeFileSync(DATA + 'meta.json', JSON.stringify(meta, null, 2));

  console.log(`Wrote data/ (hash ${hash}). Changes: +${changelog.added.length} -${changelog.removed.length} ~${changelog.changed.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
