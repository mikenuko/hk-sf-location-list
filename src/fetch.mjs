import { chromium } from 'playwright';

const NETWORK_URL = (lang) =>
  `/sf-service-core-web/service/serviceSupport/queryServiceNetworkList?lang=${lang}&region=hk&translate=${lang}`;
const VERSION_URL =
  'https://ucmp-static.sf-express.com/proxy/ccspBase/cxDistrictData/queryDistrictActiveVersionData?area=hkmotw';

// Pull every HK service point (EN + TC) by iterating districts, since a flat
// query is capped at 1000 by the gateway. Runs entirely inside a real Chrome
// page so the Huawei WAF (TLS fingerprint) is satisfied.
export async function fetchOutlets({ headless = true } = {}) {
  // Default to the locally installed Google Chrome; CI sets PW_CHANNEL=chromium
  // to use Playwright's pinned, reproducible Chromium (same TLS, clears the WAF).
  const channel = process.env.PW_CHANNEL ?? 'chrome';
  const browser = await chromium.launch({
    channel: channel === 'chromium' ? undefined : channel,
    headless,
  });
  try {
    const page = await browser.newPage();
    await page.goto('https://hk.sf-express.com/hk/en/store', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    return await page.evaluate(
      async ({ NETWORK_URL_EN, NETWORK_URL_TC, VERSION_URL }) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const call = async (url, body) => {
          for (let a = 0; a < 4; a++) {
            const r = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const j = await r.json();
            if (j.success) return j.result || [];
            await sleep(500);
          }
          return null;
        };
        const mkBody = (extra) => ({
          province: '', city: '', district: '', serviceType: '',
          locationCode: '852', keyWord: '', bizTypeCodes: '', ...extra,
        });

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

        const key = (o) => `${o.serviceCode}|${o.longitude},${o.latitude}`;
        const byKey = new Map();

        // English pass, per district.
        for (const city of enC) {
          const res = await call(NETWORK_URL_EN, mkBody({ province: 'Hong Kong', city }));
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
          const res = await call(NETWORK_URL_TC, mkBody({ city: tcCity }));
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
      },
      {
        NETWORK_URL_EN: NETWORK_URL('en'),
        NETWORK_URL_TC: NETWORK_URL('tc'),
        VERSION_URL,
      },
    );
  } finally {
    await browser.close();
  }
}
