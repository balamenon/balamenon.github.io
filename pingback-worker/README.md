# Pingback queue

This package deploys the public pingback endpoint. It validates each form submission and publishes the accepted message to a Cloudflare Queue. The laptop runs `../pingback-client/pingback_consumer.py` as an HTTP pull consumer; nothing needs to connect inbound to the laptop.

## Security model

- Turnstile is verified server-side and fails closed if its secret or hostname allowlist is absent.
- Only configured browser origins are accepted. This is defense in depth; Turnstile and rate limiting remain the abuse controls because non-browser clients can forge `Origin`.
- Requests are streamed through a 12 KiB cap before JSON parsing. Every stored field has a smaller explicit limit.
- Cloudflare's per-location rate-limit binding permits five submissions per source IP per minute. It is intentionally an abuse control, not exact accounting.
- The queue API token stays on the laptop and should have only Account → Queues → Edit access, scoped to the relevant Cloudflare account.
- The consumer writes with mode `0600`, strips terminal and bidirectional control characters again, and acknowledges only after `fsync` succeeds.
- Queue delivery is at least once. Each record contains a UUID and the consumer checks the output file before appending, preventing normal redelivery duplicates.

Do not commit `.dev.vars`, API tokens, the Turnstile secret, or the resulting `pingbacks.txt` file.

## 1. Create and connect the queue

From this directory, authenticate Wrangler and create the queue:

```sh
npx wrangler login
npx wrangler queues create bala-pingbacks --message-retention-period-secs 86400
npx wrangler queues consumer http add bala-pingbacks --batch-size 20 --message-retries 100
```

Cloudflare's free tier currently retains Queue messages for 24 hours. On a paid Workers plan, increase retention to 14 days:

```sh
npx wrangler queues update bala-pingbacks --message-retention-period-secs 1209600
```

The HTTP pull consumer is enabled with a command or in the dashboard; Cloudflare no longer supports enabling it in `wrangler.jsonc`.

## 2. Set the Worker secret and deploy

The page reuses the site's existing public Turnstile site key. Set the matching secret in this Worker:

```sh
npx wrangler secret put TURNSTILE_SECRET_KEY
npm run deploy
```

Confirm the deployed URL is `https://bala-pingback-worker.menon-bala.workers.dev`. If your Cloudflare workers.dev subdomain differs, update `API_URL` in `../pingback.js` and the `connect-src` directives in `../pingback.html` and `../_headers`.

The `namespace_id` in `wrangler.jsonc` only scopes the rate-limit counter; change `31001` if that identifier is already used by another binding in the account.

## 3. Create the laptop token

In Cloudflare, create a custom API token scoped to this account with Account → Queues → Edit. Record the queue ID from the dashboard or `npx wrangler queues info bala-pingbacks`.

Export the credentials locally (never in this repository):

```sh
export CF_ACCOUNT_ID="your-account-id"
export CF_QUEUE_ID="your-queue-id"
export CF_QUEUES_API_TOKEN="your-queues-only-token"
export PINGBACK_OUTPUT_PATH="$HOME/Documents/pingbacks.txt"
```

Test one pull:

```sh
python3 ../pingback-client/pingback_consumer.py --once
```

Then run it continuously:

```sh
python3 ../pingback-client/pingback_consumer.py
```

For always-on use, run the same command through a user-level macOS LaunchAgent whose secrets are loaded from a local, permission-restricted environment file or the macOS Keychain. Do not put the API token in a tracked plist.

## Operational caveats

- A laptop outage longer than the configured queue retention can still lose unread messages. The maximum is 24 hours on Free and 14 days on paid Workers.
- The consumer short-polls. A 20-second interval is responsive but produces empty read operations; increase `--interval` if cost matters more than latency.
- If the consumer saves a record and crashes before acknowledging it, the same message will be delivered again. The `Pingback-ID` marker makes that retry idempotent.
