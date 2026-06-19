# Deploy: self-hosted runner → JSON on the Docker host

This project is a **data pipeline**, not a website. A self-hosted GitHub Actions
runner on `mikeneko-docker-main` scrapes SF Express HK, builds the JSON, commits
it back to the repo (audit trail), and publishes the files to `/srv/sfhk/data`
on the host. Optionally a tiny nginx serves that directory.

```
GitHub schedule/dispatch
        │
        ▼
self-hosted runner (mikeneko-docker-main, HK IP → clears SF WAF)
   scrape → build → git commit data/ → rsync to /srv/sfhk/data
        │
        ▼
/srv/sfhk/data/*.json   ← single source of truth on the box
        │ (optional)
        ▼
nginx:alpine :8088  →  http://host:8088/locations.json
                       https://host.<tailnet>.ts.net/locations.json (Tailscale)
```

---

## 1. Install the self-hosted runner (one-time, on the Docker host)

GitHub → repo **Settings → Actions → Runners → New self-hosted runner → Linux x64**.
Copy the token it shows, then on `mikeneko-docker-main`:

```bash
sudo mkdir -p /opt/actions-runner && sudo chown "$USER" /opt/actions-runner
cd /opt/actions-runner
curl -o runner.tar.gz -L https://github.com/actions/runner/releases/latest/download/actions-runner-linux-x64.tar.gz
tar xzf runner.tar.gz

# Configure with the LABEL the workflow expects: "sfhk"
./config.sh --url https://github.com/mikenuko/hk-sf-location-list \
            --token <RUNNER_TOKEN_FROM_GITHUB> \
            --labels sfhk \
            --name mikeneko-docker-main --unattended

# Install as a service so it survives reboots
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

> The workflow targets `runs-on: [self-hosted, sfhk]`, so the `sfhk` label is required.

### Runner host prerequisites
The `npx playwright install --with-deps chromium` step needs apt (root) the first
time to pull Chromium's shared libs. The runner service user must be able to `sudo`
for that, **or** pre-install once manually:

```bash
cd /opt/actions-runner/_work/hk-sf-location-list/hk-sf-location-list 2>/dev/null || true
npx playwright install --with-deps chromium   # run once as a user with sudo
```

Also ensure the deploy dir is writable by the runner user:

```bash
sudo mkdir -p /srv/sfhk/data
sudo chown -R "$USER" /srv/sfhk
```

Node 22 is provided by `actions/setup-node` per-run, so you don't need it system-wide.

---

## 2. (Optional) Serve the files

```bash
# from the repo checkout on the host, or copy deploy/ over
docker compose -f deploy/docker-compose.yml up -d
curl http://localhost:8088/healthz          # -> ok
curl http://localhost:8088/locations.json | head
```

### Tailscale HTTPS (no open ports, private to your tailnet)
```bash
tailscale serve --bg 8088
# → https://mikeneko-docker-main.<tailnet>.ts.net/locations.json
tailscale serve status      # verify
# to stop: tailscale serve --https=443 off
```

---

## 3. Trigger / verify

- Manual: GitHub → **Actions → Refresh SF HK pickup locations → Run workflow → Run**
- Scheduled: daily `17 20 * * *` UTC (~04:17 HKT)
- After a run: `ls -la /srv/sfhk/data && cat /srv/sfhk/data/meta.json`

---

## Override the deploy directory
The workflow reads `DEPLOY_DIR` from the repo variable `SFHK_DEPLOY_DIR`
(Settings → Secrets and variables → Actions → Variables), defaulting to
`/srv/sfhk/data`. Set the variable to relocate without editing the workflow.
