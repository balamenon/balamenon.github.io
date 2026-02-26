# Notes Worker (Cloudflare Worker + D1)

This worker ingests Telegram notes and serves paginated notes for `notes.html`.

## Endpoints

- `POST /api/telegram/webhook`
- `GET /api/notes?page=1&page_size=10&tz=UTC`
- `GET /api/substack/posts?limit=10`
- `GET /api/status`
- `POST /api/status/replies`
- `POST /api/notes/:id/edit` (internal bearer token)
- `GET /api/health`

## Prerequisites

- Node.js 20+
- Cloudflare account
- Telegram bot token

## Setup

1. Install dependencies:

```bash
cd worker
npm install
```

2. Authenticate Wrangler:

```bash
npx wrangler whoami
# if needed
npx wrangler login
```

3. Create D1 database and copy the returned `database_id`:

```bash
npx wrangler d1 create bala_notes
```

4. Update `wrangler.jsonc`:
- `d1_databases[0].database_id`
- `vars.ALLOWED_TELEGRAM_ID`

5. Apply migrations:

```bash
npx wrangler d1 migrations apply bala_notes --local
npx wrangler d1 migrations apply bala_notes --remote
```

6. Set secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put INTERNAL_API_TOKEN
npx wrangler secret put TURNSTILE_SECRET_KEY
```

7. Deploy:

```bash
npm run deploy
```

8. Register Telegram webhook (replace URL/token/secret):

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url":"https://<your-worker-domain>/api/telegram/webhook",
    "secret_token":"<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

## Telegram commands

- `/newnote <text>` creates a note
- `/editnote` lists 20 recent notes with inline selection
- `/deletenote` lists 20 recent notes with inline delete selection
- `/reindex` fetches Substack feed and upserts posts into D1 cache
- `/setstatus <text>` sets site status text (max 100 chars)
- `/clearstatus` clears site status text
- `/enablereplies` enables visitor replies for the current status

## Security settings

- `ALLOWED_ORIGINS` (`wrangler.jsonc` var): comma-separated origin allowlist for CORS.
- `TURNSTILE_SECRET_KEY` (secret): enables bot-thought submission verification.
- Set `window.TURNSTILE_SITE_KEY` on pages that render status replies to activate Turnstile verification.

## Substack cache flow

- Trigger `/reindex` in Telegram to refresh the D1 cache.
- `index.html` should fetch `GET /api/substack/posts?limit=10` from the Worker.
- Worker reads from cached D1 rows only (no feed fetch on page load).

If text exceeds 10,000 words, the bot shows truncation preview and lets you save truncated content or cancel/edit.

## Frontend notes page

Set `window.NOTES_API_BASE` in `notes.html` to your worker URL (or deploy worker on same origin route).
