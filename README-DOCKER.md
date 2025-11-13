# Dockerized Stremio Stalker Addon

This repository contains a Node.js service (Express + stremio-addon-sdk) under `./newstalker`.
Below are Docker assets to build and run the service with **HTTPS termination** via **Caddy**.

## Files
- `Dockerfile` — builds a lightweight Node 20 Alpine image running the app on port **7100**.
- `docker-compose.yml` — starts two services:
  - `app` (your Node service)
  - `caddy` (TLS-terminating reverse proxy)
- `Caddyfile` — Caddy configuration for auto HTTPS (public DNS) or local self-signed TLS.

## Quick start (local, self-signed HTTPS)
```bash
docker compose up --build
# Visit https://localhost (your browser will warn about self-signed cert)
```

## Production (real domain with HTTPS)
1. Point your DNS A/AAAA record for your domain to the host running Docker.
2. Edit `docker-compose.yml` and set:
   - `DOMAIN=your.domain.com`
   - `EMAIL=you@example.com` (optional but recommended)
3. Open inbound ports **80** and **443** on your server/firewall.
4. Start:
```bash
docker compose up --build -d
```
5. Visit `https://your.domain.com`.

## Environment
- The Node app listens on `PORT=7100` (override with `-e PORT=...` if needed).
- `NODE_ENV=production` is set by default.

## Healthcheck
The `Dockerfile` includes a simple HTTP healthcheck to `/`. If your app exposes a
specific health endpoint (e.g. `/healthz`), adjust the `HEALTHCHECK` line accordingly.
