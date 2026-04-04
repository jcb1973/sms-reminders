# sms-reminders

A self-hosted SMS reminder service. Text it a task and a time in plain English — it schedules a reminder and texts (or calls) you back when it's due. Falls back to email if 3 attempts at SMS (or call) fail. 

## How it works

Send an SMS like:

```
pick up dry cleaning : 5pm
```

The service parses natural language times using [chrono-node](https://github.com/wanasit/chrono), queues the reminder with BullMQ, and delivers it via Twilio at the scheduled time.

**Other commands:**
- `list` — see all your pending reminders
- `cancel <id>` — cancel a scheduled reminder
- Just send a task with no time — the service will ask you when
- Append `!call` to get a voice call instead of an SMS

## Architecture

```
Incoming SMS → Twilio webhook → Express app → BullMQ queue → Redis
                                                    ↓
                                          Scheduled job fires
                                                    ↓
                                         Twilio SMS or voice call
```

The whole stack runs in Docker behind a Caddy reverse proxy with automatic HTTPS.

## Stack

- **Runtime:** Node.js + Express
- **Queue:** BullMQ + Redis
- **NLP:** chrono-node for natural language date parsing
- **Messaging:** Twilio (SMS + TTS voice calls)
- **Infrastructure:** Docker Compose, Caddy for TLS termination

## Running it

```bash
# Create .env with your Twilio creds, domain, and Redis host
docker compose up -d
```

Point your Twilio phone number's webhook at `https://yourdomain.com/sms` and start texting.

## Environment variables

| Variable | Description |
|---|---|
| `TWILIO_SID` | Twilio Account SID |
| `TWILIO_TOKEN` | Twilio Auth Token |
| `TWILIO_NUMBER` | Twilio phone number for SMS |
| `TWILIO_CALL_NUMBER` | Twilio phone number for voice calls (optional) |
| `REDIS_HOST` | Redis hostname (default: `redis` in Docker) |
| `WEBHOOK_URL` | Public URL for Twilio SMS webhook validation (e.g. `https://yourdomain.com/sms`) |
| `DOMAIN` | Your domain for Caddy HTTPS |
| `GMAIL_USER` | Gmail address for fallback email alerts (optional) |
| `GMAIL_APP_PASSWORD` | Google app password for SMTP (optional) |
| `ALERT_EMAIL_TO` | Recipient for fallback emails (optional) |
| `STATUS_PASSWORD` | Password for basic auth on `/status` endpoint (optional) |

## Reliability

- **Retries:** Failed deliveries retry 3 times with exponential backoff (30s, 60s, 120s)
- **Email fallback:** If all retries fail, sends the reminder via Gmail as a last resort
- **Persistence:** Redis data is stored on a Docker volume with AOF enabled — reminders survive restarts and redeploys
- **Monitoring:** `GET /status` shows all jobs and their state (requires basic auth: `admin`/your `STATUS_PASSWORD`)
