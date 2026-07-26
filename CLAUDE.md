# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What this is

A Node.js app that schedules SMS and voice-call reminders via Twilio. Users text a natural-language task + time (e.g., "Remind me to feed the cats at 6pm"), and the app delivers the reminder at that time.

Runs on jcblondon (Vultr VPS) as a Docker container. Fronted by Caddy for HTTPS reverse-proxying.

## Running (development)

```bash
npm install
npm start
```

Needs Redis running locally (or via Docker): `docker run -d -p 6379:6379 redis:latest`.

Environment variables (see `.env.example`):
- `TWILIO_SID`, `TWILIO_TOKEN` — Twilio credentials
- `REDIS_HOST` — Redis host (localhost in dev, `redis` in compose)
- Other optional fields: Gmail fallback, auth password for `/status` endpoint

## Deployment (on jcblondon)

Runs via Docker Compose from the `sms-reminders` directory:

```bash
ssh linuxuser@45.77.91.222
cd ~/sms-reminders && git pull
docker compose up -d --build    # rebuild + restart
```

The compose stack includes:
- Node.js app (`sms` service) — Express + BullMQ
- Redis — job queue backend
- Caddy — reverse proxy (TLS, routing to other services on the same VPS)

**Secrets:**
- `.env` file (gitignored, mode 600) contains Twilio credentials, Redis host, etc.
- `.env.example` is a template; copy and edit on the VPS

## Architecture

**Layers:**
- `index.js` — Express server; Twilio webhook handler, BullMQ job dispatcher
- `worker.js` — job processor; sends SMS/voice calls via Twilio, handles retries + fallback email
- `docker-compose.yaml` — Node + Redis + Caddy orchestration
- `Caddyfile` — reverse proxy config; routes `sms-reminders.jcb1973.dev` → localhost:3000

**State files (gitignored):**
- `.env` — secrets (Twilio, Redis, Gmail, etc.)
- Redis persists job queue (RDB snapshots)

## SMS format

- **Natural language:** `Remind me to feed the cats at 6pm`
- **Explicit:** `Pick up laundry : 5pm` (colon delimiter)
- **Voice call:** Add `!call` flag anywhere in the message
- **Shorthand:** `10m`, `2h`, `30s`, `1d`, `830` (8:30), `1430` (14:30)
- **List reminders:** Send `list`
- **Cancel:** Send `cancel <id>`

If no time is provided, the app asks in a follow-up message.

## Cron & monitoring

This is a **live service**, not a scheduled job:
- Webhook-driven (Twilio → Express → Redis queue)
- Job worker processes queued reminders on schedule (BullMQ)
- No cron; state is managed by Redis + systemd restart policy (Docker)

If you add monitoring, watch:
- Redis queue depth: `redis-cli llen bull:reminders:* | sum`
- App logs: `docker compose logs sms -f`
- Caddy logs: `docker compose logs caddy -f`

## Related

- `infra/README.md` — jcblondon VPS setup and other services
- `Caddyfile` documents the reverse-proxy setup; other services (guitarwatch, boatwatch, etc.) share this Caddy instance
- See `DEPLOY.md` (forthcoming) for detailed zero-downtime update patterns

## Known gotchas

- Twilio webhook validation must pass the auth token as the **second positional arg** to `twilio.webhook()`, not as an option (SDK quirk)
- Voice calls use inline TwiML; no separate endpoint needed
- Retries are exponential backoff (30s, 60s, 120s); after 3 failed attempts, fallback email is sent (requires Gmail SMTP setup)
