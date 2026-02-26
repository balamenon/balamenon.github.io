# Security Best Practices Review Report

> Status update (February 26, 2026): Findings SEC-001 through SEC-004 in this report have been remediated in the current working tree.

## Executive Summary

The codebase already follows several good practices (parameterized SQL in D1, origin allowlisting for browser APIs, webhook secret validation, and basic rate limiting on public thought submissions). The main gaps are in secure defaults around frontend hardening headers, fail-open anti-bot verification behavior, and unvalidated external URLs from RSS content.

The highest-risk issue is unvalidated article links from RSS content being rendered directly as clickable `href` values, which can allow `javascript:`/`data:` URL injection if feed content is compromised or replaced. Two additional medium-severity issues are present: Turnstile verification fails open when the secret is not configured, and no request-size caps are enforced before JSON parsing on public endpoints.

## Critical Findings

None.

## High Findings

### SEC-001: Unvalidated RSS links are rendered as clickable URLs
- Severity: High
- Location:
  - `worker/src/substack.ts:58`
  - `worker/src/substack.ts:63`
  - `index.html:112`
- Evidence:
  - RSS `<link>` is extracted and stored with no URL scheme/host validation (`const link = decodeXmlEntities(extractTag(block, "link"));`).
  - Any non-empty link is accepted (`if (!title || !link) continue;`).
  - The frontend assigns this value directly to `rowLink.href`.
- Impact:
  - If feed content is compromised (or if feed source is changed), malicious URLs such as `javascript:` can be rendered and executed on user click, enabling phishing or script execution in the page context.
- Fix:
  - Validate links server-side before caching: allow only `https:` and (optionally) an explicit host allowlist (e.g., `*.substack.com`).
  - On the frontend, defensively reject non-HTTP(S) schemes before assigning `href`.
- Mitigation:
  - Add CSP restrictions to reduce impact of script-based payloads.
- False positive notes:
  - If feed provenance is strictly controlled and immutable this risk is reduced, but secure-by-default code should still validate URL schemes.

## Medium Findings

### SEC-002: Turnstile validation is fail-open when secret is missing
- Severity: Medium
- Location:
  - `worker/src/index.ts:166`
  - `worker/src/index.ts:168`
- Evidence:
  - `verifyTurnstile` returns `true` when `TURNSTILE_SECRET_KEY` is missing.
- Impact:
  - Misconfiguration silently disables bot protection on a public write endpoint (`/api/notes/:id/thoughts`), increasing spam/abuse risk.
- Fix:
  - Fail closed in production: if Turnstile is expected, reject requests when secret is missing.
  - Optionally gate this by explicit env mode (e.g., `ENV=development` can bypass, production cannot).
- Mitigation:
  - Keep strict rate limits and add abuse monitoring/alerts.
- False positive notes:
  - If anti-bot protection is intentionally disabled by design, document this explicitly and rely on alternate controls.

### SEC-003: No explicit request body size limits before JSON parsing
- Severity: Medium
- Location:
  - `worker/src/index.ts:86`
  - `worker/src/index.ts:243`
  - `worker/src/telegram.ts:374`
- Evidence:
  - Public endpoints call `request.json()` directly without checking `Content-Length` or enforcing a max body size.
- Impact:
  - Large payloads can increase memory/CPU use and facilitate DoS attempts on Worker instances.
- Fix:
  - Enforce explicit max body size per endpoint before parsing (e.g., 8-32 KB for thoughts/webhook payloads).
  - Return `413 Payload Too Large` when limits are exceeded.
- Mitigation:
  - Keep endpoint-level rate limiting and apply edge WAF/request-size rules where available.
- False positive notes:
  - Cloudflare platform limits help, but app-level caps are still recommended secure defaults.

### SEC-004: Missing explicit CSP/security headers for static pages
- Severity: Medium
- Location:
  - `index.html` (head; no CSP meta/header visible in repo)
  - `notes.html` (head; no CSP meta/header visible in repo)
  - `about.html` (head; no CSP meta/header visible in repo)
- Evidence:
  - No CSP or other browser hardening headers are visible in repository-managed HTML.
- Impact:
  - Weakens defense-in-depth against XSS, clickjacking, and mixed-content/script injection issues.
- Fix:
  - Prefer HTTP response headers at edge: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and framing controls (`frame-ancestors` in CSP).
  - If header control is unavailable, add an early `<meta http-equiv="Content-Security-Policy" ...>` as partial protection and migrate inline scripts/styles toward nonce/hash-based policies.
- Mitigation:
  - Audit all third-party script origins and keep them minimal.
- False positive notes:
  - These may be set in hosting/CDN config not visible in this repo; verify runtime headers in production.

## Low Findings

None.

## Positive Practices Observed
- Parameterized D1 queries are used broadly (`worker/src/db.ts`), reducing SQL injection risk.
- CORS uses explicit origin allowlisting (`worker/src/index.ts`).
- Telegram webhook checks a secret token (`worker/src/telegram.ts`).
- Public thought endpoint applies per-IP rate limiting (`worker/src/index.ts`, `worker/src/db.ts`).

## Secure-by-Default Improvement Plan
1. Add URL validation for RSS links before DB write and before frontend render.
2. Make Turnstile behavior explicit and fail closed in production.
3. Add request body size guards and `413` handling for JSON endpoints.
4. Apply CSP and baseline security headers at edge; then reduce inline script/style usage to support stricter CSP.
5. Add targeted tests for URL validation, Turnstile config handling, and body size enforcement.
