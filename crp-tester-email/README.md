# crp-tester-email

Cloudflare Worker that sends CRP Tester Program confirmation emails through
Resend.

This is an **email-only backend**. It does not write to Firestore and holds no
database credentials. The browser still performs the Firestore submission
(`js/signup.js`), then calls this Worker so the applicant gets an
acknowledgement.

## Why it is separate from the Firestore path

The application's source of truth is the Firestore `requests` document. The
email is a best-effort follow-up, which means **a Worker or Resend failure can
never lose someone's application.** `tests/e2e-worker-failure.js` proves this by
breaking the Worker call and asserting the request is still stored and the
visitor still reaches the confirmation page.

The trade-off: a stored request whose email failed is not retried automatically.
It is still visible in the admin queue, so nothing is lost, but re-sending a
missed acknowledgement is a manual step for now.

## Request flow

```
browser  ──POST /send──▶  Worker  ──POST──▶  api.resend.com/emails
   │                      │
   │                      ├─ origin allow-list  (https://crp-company.github.io)
   │                      ├─ input validation
   │                      └─ Idempotency-Key: <requestId>
   │
   └── (separately) ──▶ Firestore `requests`  ← the real submission
```

`POST /send` body:

```json
{ "name": "Alex Morgan", "email": "alex@example.com", "requestId": "req_abc123" }
```

Responses: `200 {ok:true,id}` · `400` invalid input · `403` bad origin ·
`502` Resend failure · `405` wrong method.

`GET /` is a health check that reports whether the API key is configured,
without revealing it.

## Configuration

| Name | Where | Notes |
|---|---|---|
| `RESEND_API_KEY` | **Worker secret** | Never in `wrangler.jsonc` |
| `ALLOWED_ORIGINS` | `wrangler.jsonc` | Comma-separated; defaults to the live site |
| `CRP_EMAIL_FROM` | `wrangler.jsonc` | Sender address |
| `CRP_EMAIL_LOGO_URL` / `CRP_EMAIL_HERO_URL` / `CRP_SITE_URL` / `CRP_PRIVACY_URL` | optional | Override the template's asset URLs |

Set the secret (prompts for the value, encrypts it):

```bash
npx wrangler secret put RESEND_API_KEY
```

Locally, copy `.dev.vars.example` to `.dev.vars` (gitignored).

## Security notes

- **Origin allow-list.** `Origin` is browser-set, so it stops other sites from
  using this as a mail relay. It is *not* authentication — a non-browser client
  can send any header — so treat it as one layer, not a guarantee.
- **Validation** mirrors the limits in `firestore.rules`, so a crafted direct
  call cannot push junk into an inbox.
- **No Turnstile yet.** The browser's honeypot is the only bot control. Adding
  Turnstile is the next step and the main remaining gap.
- **Resend's error text is logged but never returned**, so a caller learns
  nothing about the Resend account.

## Tests

```bash
npm test        # 48 tests: routing, origin, validation, Resend contract, escaping
npm run dev     # local dev server on :8787
```

`test/index.spec.js` stubs `fetch`, so the suite never touches the network.

## Before sending real mail

`CRP_EMAIL_FROM` is `CRP Tester Program <testing@crp.company>`. Resend will
reject mail from a domain you have not verified, so confirm
`crp.company` is verified in the Resend dashboard first.
