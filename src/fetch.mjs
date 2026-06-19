import { createHash } from 'node:crypto';

// SF Express HK signs every API request (added ~2026-06-18). The signature is
// computed client-side and sent as headers; no browser is needed once we
// replicate it. Algorithm reverse-engineered from their Next.js bundle
// (module 28480 "commonSign"): MD5 over alphabetically-sorted
// appId/appSecret/nonce/timestamp[/body] joined "k=v&...", lowercase hex.
const APP_ID = process.env.SF_APP_ID || 'ef665282ac384e088441ea9539db26d5';
const APP_SECRET = process.env.SF_APP_SECRET || '439f674b609b4a27ab04631ca272abbb';

const NETWORK_URL = (lang) =>
  `https://hk.sf-express.com/sf-service-core-web/service/serviceSupport/queryServiceNetworkList?lang=${lang}&region=hk&translate=${lang}`;
const VERSION_URL =
  'https://ucmp-static.sf-express.com/proxy/ccspBase/cxDistrictData/queryDistrictActiveVersionData?area=hkmotw';

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const nonceStr = (len = 6) => {
  let r = '';
  // Mirror the bundle exactly: index in [0, len(chars)-1) (last char never picked).
  for (let i = 0; i < len; i++) r += NONCE_CHARS[Math.floor(Math.random() * (NONCE_CHARS.length - 1))];
  return r;
};

// Returns the 4 signing headers for a given JSON body (or null body).
function signHeaders(body) {
  const nonce = nonceStr(6);
  const timestamp = String(Date.now());
  const bodyStr = body != null ? JSON.stringify(body) : null;
  const pairs = [
    ['appId', APP_ID],
    ['appSecret', APP_SECRET],
    ['nonce', nonce],
    ['timestamp', timestamp],
  ];
  if (bodyStr !== null) pairs.push(['body', bodyStr]);
  pairs.sort((a, b) => (a[0] > b[0] ? 1 : a[0] < b[0] ? -1 : 0));
  const sign = createHash('md5').update(pairs.map((p) => p.join('=')).join('&')).digest('hex');
  return { appId: APP_ID, nonce, timestamp, sign };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Signed POST to the network-list API with retries.
async function call(url, body) {
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          ...signHeaders(body),
        },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (j.success) return j.result || [];
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  return null;
}

const key = (o) => `${o.serviceCode}|${o.longitude},${o.latitude}`;
const mkBody = (extra) => ({
  province: '', city: '', district: '', serviceType: '',
  locationCode: '852', keyWord: '', bizTypeCodes: '', ...extra,
});

// Pull every HK service point (EN + TC) by iterating districts; a flat query is
// capped by the gateway, so we go district-by-district. No browser required —
// requests are signed directly. The `headless` arg is accepted for API
// compatibility with the old browser-based version but is unused.
export async function fetchOutlets(/* { headless } = {} */) {
  // Versioned district reference data → index-aligned EN/TC county names.
  const ver = await (await fetch(VERSION_URL)).json();
  const enTree = await (await fetch(ver.obj.fileEnUrl)).json();
  const tcTree = await (await fetch(ver.obj.fileTcUrl)).json();
  const counties = (tree) => {
    const out = [];
    const hk = tree.find((r) => r.l === '852');
    (hk.city || []).forEach((c) => (c.county || []).forEach((co) => out.push(co.f)));
    return out;
  };
  const enC = counties(enTree);
  const tcC = counties(tcTree);
  const en2tc = {};
  enC.forEach((n, i) => (en2tc[n] = tcC[i]));

  const byKey = new Map();

  // English pass, per district.
  for (const city of enC) {
    const res = await call(NETWORK_URL('en'), mkBody({ province: 'Hong Kong', city }));
    if (res) {
      for (const o of res) {
        const k = key(o);
        if (!byKey.has(k)) {
          byKey.set(k, {
            id: o.serviceCode,
            name_en: o.name, name_tc: null,
            address_en: o.address, address_tc: null,
            telephone: o.telephone,
            serviceTime_en: o.serviceTime, serviceTime_tc: null,
            lat: o.latitude, lng: o.longitude,
            province: o.province, city: o.city, district: o.district,
            bizTypeCode: o.bizTypeCode,
          });
        }
      }
    }
    await sleep(180);
  }

  // Traditional-Chinese pass (filter needs Chinese city names); patch by key.
  let tcPatched = 0;
  for (const enCity of enC) {
    const tcCity = en2tc[enCity];
    if (!tcCity) continue;
    const res = await call(NETWORK_URL('tc'), mkBody({ city: tcCity }));
    if (res) {
      for (const o of res) {
        const e = byKey.get(key(o));
        if (e) {
          e.name_tc = o.name;
          e.address_tc = o.address;
          e.serviceTime_tc = o.serviceTime;
          e.city_tc = o.city; // Chinese district (county) name
          e.district_tc = o.district; // Chinese sub-district (town) name
          tcPatched++;
        }
      }
    }
    await sleep(180);
  }

  return { sourceVersion: ver.obj.version, tcPatched, rows: [...byKey.values()] };
}
