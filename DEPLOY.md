# Deployment Guide: SMS Reminders on jcblondon

This guide covers deploying SMS Reminders updates to the production server (jcblondon, Vultr VPS 45.77.91.222) with zero downtime.

## Quick Deploy (no breaking changes)

If you're only updating Node.js code (not Caddyfile, Redis config, or dependencies):

```bash
ssh linuxuser@45.77.91.222
cd ~/sms-reminders
git pull
docker compose up -d --build    # rebuild image, restart container
```

Caddy will keep serving while the Node app reloads (BullMQ queue persists to Redis). Pending jobs continue from the queue.

## Full Deploy (with config/dependency changes)

If you've changed `package.json`, `.env`, or Caddyfile:

```bash
ssh linuxuser@45.77.91.222
cd ~/sms-reminders
git pull
docker compose down
docker compose up -d --build    # full stack restart
```

**Note:** This stops the app, Redis, and Caddy. Any jobs in progress are paused until the stack comes back. With Redis persistent storage, jobs resume after restart.

## Secrets (.env)

The `.env` file lives on jcblondon (not in the repo) and contains:

```ini
TWILIO_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_TOKEN=your_token_here
TWILIO_NUMBER=+46701234567
TWILIO_CALL_NUMBER=+11234567890
WEBHOOK_URL=https://sms-reminders.jcb1973.dev/sms
DOMAIN=sms-reminders.jcb1973.dev
REDIS_HOST=redis
REDIS_PORT=6379
GMAIL_USER=john@gmail.com
GMAIL_APP_PASSWORD=xyzabc123
ALERT_EMAIL_TO=john@gmail.com
STATUS_PASSWORD=mypass123
```

To update a secret:

```bash
ssh linuxuser@45.77.91.222
nano ~/sms-reminders/.env  # edit
docker compose up -d       # restart to pick up env changes
```

## Monitoring & Debugging

**App logs:**

```bash
docker compose logs sms -f          # stream app output
docker compose logs sms --tail 50   # last 50 lines
```

**Redis queue depth:**

```bash
docker compose exec redis redis-cli LLEN bull:reminders:*
```

**Caddy reverse-proxy logs:**

```bash
docker compose logs caddy -f
```

**Check service status:**

```bash
docker compose ps                   # all services
docker compose exec sms curl localhost:3000/health
```

## Troubleshooting

### SMS not sending

1. Check Twilio credentials in `.env`
2. Check job queue: `docker compose exec redis redis-cli KEYS "bull:reminders:*"`
3. Check worker logs: `docker compose logs sms | grep -i error`
4. If the worker is stuck, restart: `docker compose restart sms`

### Caddy TLS certificate issues

Caddy auto-renews certificates. If renewal fails:

```bash
docker compose logs caddy | grep certificate
docker compose restart caddy
```

### Redis full / disk space

Check disk usage on the VPS:

```bash
df -h
du -sh ~/sms-reminders/
```

If Redis disk is full, back up and truncate RDB:

```bash
docker compose exec redis redis-cli BGSAVE
docker compose exec redis redis-cli FLUSHDB  # WARNING: clears queue
```

### Port already in use

If port 3000 is taken by another service:

```bash
sudo lsof -i :3000
sudo kill -9 PID  # if it's a stale process
docker compose up -d  # restart
```

## Zero-Downtime Update Pattern

For critical updates, use this pattern:

1. **Deploy to a staging environment** (if possible) or test the changes locally
2. **Pull on the VPS and rebuild:**
   ```bash
   ssh linuxuser@45.77.91.222
   cd ~/sms-reminders && git pull
   docker compose up -d --build
   ```
3. **Verify health:**
   ```bash
   docker compose exec sms curl localhost:3000/health
   docker compose logs sms --tail 10
   ```
4. **Check Caddy is routing:**
   ```bash
   curl -v https://sms-reminders.jcb1973.dev/
   ```
5. **Wait 30 seconds**, then verify a test reminder still works:
   ```bash
   # Send a test SMS via Telegram or curl
   ```

**Rollback (if something breaks):**

```bash
git reset --hard HEAD~1  # revert the commit
docker compose up -d --build
```

## Scaling Redis persistence

Redis data is stored in `redis-data/` (Docker volume). To avoid data loss on crashes:

```bash
# Current config (in compose.yaml)
volumes:
  - redis-data:/data
```

To increase snapshot frequency, edit `redis.conf` (if you add one) and bind-mount it:

```yaml
services:
  redis:
    command: redis-server /conf/redis.conf
    volumes:
      - ./redis.conf:/conf/redis.conf
      - redis-data:/data
```

## Caddy integration

SMS Reminders shares the Caddy reverse proxy with other jcblondon services (guitarwatch, boatwatch, etc.). The routing rule in `Caddyfile`:

```
sms-reminders.jcb1973.dev {
    reverse_proxy sms:3000
}
```

If you change the port or container name, update Caddyfile and restart Caddy:

```bash
docker compose up -d caddy
```

## Alerts & monitoring (future)

To set up alerting on job failures:

1. Configure a Slack webhook in `.env`: `SLACK_WEBHOOK_URL=…`
2. In `worker.js`, send a message on failure: `await slack.send(…)`
3. Or use Caddy's `/status` endpoint with basic auth: `curl -u admin:PASSWORD https://sms-reminders.jcb1973.dev/status`

## Related

- `infra/README.md` — jcblondon VPS setup
- `Caddyfile` — reverse proxy config (shared with other services)
- `docker-compose.yaml` — stack orchestration
- `index.js` / `worker.js` — app logic
