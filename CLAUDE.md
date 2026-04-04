# SMS Reminders

Single-file Node.js app (`index.js`) that lets you schedule reminders via SMS. Text a task and time, get an SMS or phone call when it's due.

## Architecture

- **Express** receives incoming SMS via Twilio webhook at `POST /sms`
- **chrono-node** parses natural language times
- **BullMQ** + **Redis** schedules delayed jobs
- **Twilio** sends SMS reminders or makes voice calls
- **Caddy** reverse proxy handles HTTPS with auto Let's Encrypt certs

## SMS format

- `Task : time` — e.g. `Pick up laundry : 5pm`
- `Task : time !call` — delivers reminder as a phone call instead of SMS
- Just `Task` — app asks for time in a follow-up (multi-turn, stored in Redis with 5min TTL)
- `list` — shows pending reminders
- `cancel <id>` — cancels a reminder
- Shorthand times: `10m`, `2h`, `30s`, `1d`
- Bare clock times: `830`, `1430` expanded to `8:30`, `14:30`
- Delimiter is ` : ` (space-colon-space) to avoid conflicts with times like `12:05`

## Deployment

Runs on AWS Lightsail (Ubuntu 24.04, 2GB RAM) via Docker Compose.

```bash
# On server
git pull && docker compose up -d --build
```

Use `docker compose` (space, v2 plugin) for all commands.

## Environment variables (in .env on server, not committed)

- `TWILIO_SID` — Twilio account SID
- `TWILIO_TOKEN` — Twilio auth token
- `TWILIO_NUMBER` — Swedish number for SMS (inbound + outbound SMS)
- `TWILIO_CALL_NUMBER` — US number for outbound voice calls (Sweden doesn't support Twilio voice)
- `WEBHOOK_URL` — full public URL for webhook validation (e.g. `https://domain/sms`)
- `DOMAIN` — domain for Caddy TLS (used in docker-compose)
- `REDIS_HOST` — set to `redis` in docker-compose
- `GMAIL_USER` — (optional) Gmail address for fallback email alerts
- `GMAIL_APP_PASSWORD` — (optional) Google app password for SMTP
- `ALERT_EMAIL_TO` — (optional) recipient for fallback email when all retries fail
- `STATUS_PASSWORD` — (optional) password for basic auth on `/status` endpoint (username: `admin`)

## Key implementation details

- Twilio webhook validation: auth token must be passed as second positional arg to `twilio.webhook()`, not as an option — the SDK overwrites `options.authToken`
- Voice calls use inline TwiML (`twiml` param on `client.calls.create()`), no separate endpoint needed
- Job data: `{ to, message, call }` — `call: true` triggers voice instead of SMS
- Worker has a `failed` event handler that logs errors and sends a fallback email (via Gmail SMTP) on final failure
- Jobs retry 3 times with exponential backoff (30s, 60s, 120s) before triggering the email fallback
