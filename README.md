# CRP · Early Access

Static landing page with a Firebase backend. Signups go to Firestore, staff
review them in a small admin dashboard, and approved applicants become testers
with an explicit active / not-active state.

## The data model

Two sibling collections, deliberately separate lifecycles:

```
requests/{requestId}        public intake, append-only from the visitor's view
  name, email, consent, source, userAgent
  status        pending | approved | rejected
  createdAt, updatedAt, reviewedBy, reviewedAt, note

testers/{testerId}          accepted testers ONLY, staff-managed
  requestId, name, email
  status        pending | accepted | rejected | revoked   <-- lifecycle
  appliedAt, acceptedAt, testerNumber
  statusChangedAt, statusChangedBy
  active         <-- the active / not-active flag
  activatedAt, deactivatedAt, deactivatedBy, deactivationReason
  wallet         { issuerId, classId, accountId, objectId, lastIssuedAt }
  activity       { lastPeriod, comments, reviews }

testers/{testerId}/activity/{YYYY-MM}   immutable per-period counts
requestEmails/{sha256(email)}           duplicate-lookup marker
meta/testerCounter                      sequential tester-number counter
audit/{entryId}                         append-only trail of staff actions
```

### Tester status vs. the active flag

`status` is the lifecycle; `active` is the boolean the rules, queries and
Wallet logic already depend on. They are written together and cannot drift:

| status | active | meaning |
|---|---|---|
| `pending` | `false` | applied, not yet reviewed |
| `accepted` | `true` | in the program |
| `rejected` | `false` | turned down; no benefits granted |
| `revoked` | `false` | was accepted, now removed — Wallet pass is REVOKED |

`setTesterActive` is the everyday toggle (accepted <-> revoked);
`setTesterStatus` covers transitions about the application itself, notably
`rejected`.

### Sequential tester numbers

Assigned on acceptance, inside a transaction on `meta/testerCounter`. A plain
read-then-write would hand the same number to two admins accepting at the same
moment — `tests/tester-status.test.js` includes a control test proving the naive
version collapses to a single number under concurrency while the transactional
one yields a clean 1..25. A number is never reassigned, so a tester keeps theirs
even if later revoked.

**Why the split.** A request is a transient lead; a tester is a persistent
program member. Keeping them apart means a query for active testers never drags
unvetted applicant rows along with it, and an applicant can re-apply without
disturbing an existing tester record.

**Why `active` is a boolean.** One indexed field, so `where("active", "==", true)`
is a single cheap query. Deactivation also drives the Google Wallet pass state,
so an inactive tester receives a `REVOKED` card rather than a live one.

## Who can write what

| Path | Written by | Enforced by |
|---|---|---|
| `requests` create | public visitor | `firestore.rules` — exact field allowlist |
| `requests` decide | `decideRequest` callable | `admin` claim, re-checked in code |
| `testers` | **Cloud Functions only** | `allow create, update, delete: if false` |
| `testers.active` | `setTesterActive` callable | `admin` claim + mandatory reason |
| `audit` | Cloud Functions only | `allow write: if false` |

Callables run with Admin SDK rights and therefore **bypass** security rules, so
each one re-checks the `admin` custom claim in code. That is two independent
checks, not one.

## Public form

`js/signup.js` is a plain ES module loading the SDK from the gstatic CDN — no
bundler, no build step, so the site still deploys to GitHub Pages unchanged.

The rules pin the public write tightly:

- `status` must be exactly `"pending"` — a visitor cannot self-approve
- `createdAt` must equal `request.time` — blocks timestamp spoofing
- a `website` honeypot must be empty — hidden from humans, filled by bots
- `hasOnly([...])` — no extra fields can be smuggled in
- no `list` anywhere — applicant emails are never enumerable

## Setup

```bash
npm install
npm i --prefix functions

# 1. Point the project at Firebase
#    .firebaserc already lists crp-cuby-display; change it if needed

# 2. Paste your web config into js/firebase-config.js and
#    admin/js/firebase-config.js  (see the .example.js templates)

# 3. Create the Firestore database, Auth provider (Email/Password), then:
npm run deploy:rules
npm run deploy:functions

# 4. Create a staff user in Firebase console > Authentication, then:
node scripts/set-admin-claim.js you@crp.com
```

Cloud Functions must live in the same region as the Firestore database. This
project uses `europe-west1` — see `functions/index.js`.

### Google Wallet credentials

The pass builder reads the service account from the environment, never from a
file in the repo:

```bash
export GOOGLE_APPLICATION_CREDENTIALS_JSON="$(cat crp-tester-card-*.json)"
npm run test:wallet
```

For the deployed function, store it in Secret Manager and reference it via
`defineSecret` rather than an env var.

## Pages

| Path | Purpose |
|---|---|
| `/` | Landing page with the signup form |
| `/sent.html` | Confirmation after a successful request |
| `/admin/` | Staff dashboard |

`sent.html` reuses the landing page's type scale, grid overlay and pill
buttons, so it reads as the same site. It names the submitted address back to
the visitor via `sessionStorage`; opened directly or with storage blocked, it
falls back to generic wording. The logo is the same asset the landing page uses
(`i.postimg.cc/K8zf4q4q/CRPlogo.png`); the wrapper crops the large transparent
margin baked into that file, so swapping in a tighter logo needs no CSS change.

Append `?emulator=1` to `/` to route submissions to the local emulator.

## Testing

```bash
npm test              # exports + 23 rules tests
npm run test:rules    # 23 rules tests against the Firestore emulator
npm run test:wallet   # JWT shape, and pass state follows `active`
npm run test:e2e      # real form submission -> rules -> sent.html
npm run emulators     # local Firestore + Auth + Functions
npm run dev           # static preview on :8900
```

`tests/rules.test.js` covers the guarantees that matter: a visitor can create a
request and nothing else, no client can write `testers`, a tester can read only
their own record, and the audit trail is unreachable from any client.

`tests/e2e-signup.js` drives a real browser through the form and asserts the
document that lands in Firestore, that the email is normalised, that a repeat
submission is refused, and that `testers` stays empty — the separation guarantee
held end to end.

## Admin dashboard

`/admin` — sign in with an account holding the `admin` claim. Lists the request
queue and the tester roster side by side, with approve/reject, the active
toggle, and one-click wallet pass issuance.

The dashboard never writes to Firestore directly; every mutation is a callable,
so a tampered client cannot approve a request or flip a status.

## Transactional email (Resend)

Confirmation emails are sent by a **Cloudflare Worker**, not by Cloud Functions.
The Firestore path cannot do it: Cloud Functions and Secret Manager both require
the Blaze plan, and this project is on the free Spark plan.

```
browser  -> Firestore `requests`   (the real submission, unchanged)
browser  -> Worker /send    -> Resend  (best-effort acknowledgement)
```

| Path | Role |
|---|---|
| `crp-tester-email/` | The Worker. See its own README for detail. |
| `js/signup.js` | Calls the Worker after `addDoc()` succeeds |
| `js/worker-config.js` | The Worker URL (public, safe to commit) |
| `functions/src/email*.js` | The earlier Firestore-trigger path, superseded |

**The email is best-effort and cannot lose an application.** The request is
written to Firestore first; the Worker call happens afterwards, and every
failure path is swallowed after logging. `tests/e2e-worker-failure.js` proves it
by breaking the Worker call and asserting the request is still stored and the
visitor still reaches the confirmation page.

Because the Worker never writes to Firestore, it holds **no database
credentials** — only the Resend key, as an encrypted Worker secret:

```bash
cd crp-tester-email
npx wrangler secret put RESEND_API_KEY
```

**Duplicate protection:** the Firestore request id is passed as the Resend
`Idempotency-Key`, so a retry for the same request cannot send a second email.

**Sender:** `CRP Tester Program <testing@crp.company>`, set in
`wrangler.jsonc`. Resend rejects mail from unverified domains, so confirm
`crp.company` is verified in the Resend dashboard before going live.

The older `onRequestCreated` Cloud Function remains in `functions/` for
reference but is not deployed. See `crp-tester-email/README.md` for the
Worker's API and security notes.


## Activity enforcement

The landing page promises inactive testers are removed. `recordActivity` writes
an immutable per-period record and deactivates anyone below the threshold, so
that promise is enforced mechanically and there is a history to appeal against.