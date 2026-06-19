# Deploy: self-hosted runner → JSON on the same server

This project is a **data pipeline**, not a website. A self-hosted GitHub Actions
runner scrapes SF Express HK, builds the JSON, commits it back to the repo
(audit trail), and **writes the files to a local directory on the runner's own
server**. No Docker, no web server required — the "deploy" is just a file copy
on the machine the job already runs on.

```
GitHub schedule/dispatch
        │
        ▼
self-hosted runner (your server, HK IP → clears SF WAF)
   scrape → build → git commit data/ → rsync to $DEPLOY_DIR
        │
        ▼
$DEPLOY_DIR/*.json   ← the published files, right there on the box
```

Whatever consumes the data (another app, a script, a cron, a service) just reads
`$DEPLOY_DIR/locations.json` directly off the local filesystem.

---

## 1. Install the self-hosted runner (one-time, on your server)

GitHub → repo **Settings → Actions → Runners → New self-hosted runner → Linux x64**.
Copy the token it shows, then on the server:

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -o runner.tar.gz -L https://github.com/actions/runner/releases/latest/download/actions-runner-linux-x64.tar.gz
tar xzf runner.tar.gz

# Configure with the LABEL the workflow expects: "sfhk"
./config.sh --url https://github.com/mikenuko/hk-sf-location-list \
            --token <RUNNE…HUB> \
            --labels sfhk \
            --name sfhk-runner --unattended

# Install as a service so it survives reboots
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

> The workflow targets `runs-on: [self-hosted, sfhk]`, so the `sfhk` label is required.

---

## 2. Host prerequisites

**Chromium for the scrape.** The `npx playwright install --with-deps chromium`
step needs apt (root) the first time to pull Chromium's shared libs. Either let
the runner user `sudo`, or pre-install once manually as a sudo-capable user:

```bash
cd ~/actions-runner/_work/hk-sf-location-list/hk-sf-location-list 2>/dev/null || true
npx playwright install --with-deps chromium
```

**Deploy directory writable by the runner user:**

```bash
sudo mkdir -p /srv/sfhk/data
sudo chown -R "$(whoami)" /srv/sfhk     # or whatever user runs the runner service
```

Node 22 is provided per-run by `actions/setup-node`, so you don't need it system-wide.

---

## 3. Where the files land

The workflow reads `DEPLOY_DIR` from the repo variable `SFHK_DEPLOY_DIR`
(**Settings → Secrets and variables → Actions → Variables**), defaulting to
`/srv/sfhk/data`. Set that variable to point anywhere the runner user can write —
e.g. a web root, a shared mount, or an app's data folder.

```
$DEPLOY_DIR/locations.json          # all outlets (flat array)
$DEPLOY_DIR/locations.csv           # spreadsheet (UTF-8 BOM)
$DEPLOY_DIR/locations.geojson       # GeoJSON FeatureCollection
$DEPLOY_DIR/by-district/<d>.json    # one file per HK district
$DEPLOY_DIR/meta.json               # version, counts, hash, district index
$DEPLOY_DIR/changelog.json          # added/removed/changed ids vs previous run
```

The `.snapshot.json` internal diff artifact is excluded from the deploy.

---

## 4. Trigger / verify

- Manual: GitHub → **Actions → Refresh SF HK pickup locations → Run workflow → Run**
- Scheduled: daily `17 20 * * *` UTC (~04:17 HKT)
- After a run on the server: `ls -la /srv/sfhk/data && cat /srv/sfhk/data/meta.json`

---

## (Optional) Serve the files over HTTP

If you ever want a URL instead of raw files, point any web server at `$DEPLOY_DIR`.
Minimal example with the runner host's existing nginx:

```nginx
location /sfhk/ {
    alias /srv/sfhk/data/;
    autoindex on;
    add_header Access-Control-Allow-Origin "*";
    default_type application/json;
}
```

But for a private internal feed, reading the files straight off disk is usually all you need.
