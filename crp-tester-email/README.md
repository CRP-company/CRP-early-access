# crp-tester-email

Cloudflare Worker for CRP Tester Program email and authenticated admin
operations.

The browser submits applications directly to Firestore. This Worker sends the
best-effort acknowledgement and owns the authenticated request-review and
tester-lifecycle routes, using a Firebase service account for privileged
writes.

## Why it is separate from the Firestore path

The application's source of truth is the Firestore `requests` document. The
email is a best-effort follow-up, which means **a Worker or Resend failure can
never lose someone's application.** `tests/e2e-worker-failure.js` proves this by
breaking the email request and asserting that the application remains stored.
Admin decisions are different: `/accept` commits request status changes through
the Worker, atomically releasing a rejected request's email marker only when
that marker still belongs to that request.

The trade-off: a stored request whose email failed is not retried automatically.
It is still visible in the admin queue, so nothing is lost, but re-sending a
missed acknowledgement is a manual step for now.

## Request flow

```
browser ──Firestore transaction──▶ requests + requestEmails
   │
   ├──POST /send─────────────▶ Worker ──▶ Resend
   └──admin /accept, /tester-status, /tester-remove, /tester-wallet──▶ Worker
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
| `FIREBASE_PROJECT_ID` | `wrangler.jsonc` | Must match the service account project |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | **Worker secret** | Used only by authenticated admin routes |
| `GOOGLE_WALLET_SERVICE_ACCOUNT_JSON` | **Worker secret** | Signs Wallet passes |
| `ALLOWED_ORIGINS` | `wrangler.jsonc` | Comma-separated; defaults to the live site |
| `CRP_EMAIL_FROM` | `wrangler.jsonc` | Sender address |
| `CRP_EMAIL_LOGO_URL` / `CRP_EMAIL_HERO_URL` / `CRP_SITE_URL` / `CRP_PRIVACY_URL` | optional | Override the template's asset URLs |

Set the secret (prompts for the value, encrypts it):

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
npx wrangler secret put GOOGLE_WALLET_SERVICE_ACCOUNT_JSON
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
- **Admin writes.** Admin routes verify the Firebase ID token and `admin` claim
  before using the service account. Never expose these Worker secrets to the
  browser or commit them.
- **Resend's error text is logged but never returned**, so a caller learns
  nothing about the Resend account.

## Tests

```bash
npm test        # Worker tests: routing, decisions, Firestore, validation, email
npm run dev     # local dev server on :8787
```

`test/index.spec.js` stubs `fetch`, so the suite never touches the network.

## Before sending real mail

`CRP_EMAIL_FROM` is `CRP Tester Program <testing@crp.company>`. Resend will
reject mail from a domain you have not verified, so confirm
`crp.company` is verified in the Resend dashboard first.
