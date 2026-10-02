# CRP · Early Access

Static landing page with a Firebase backend. Signups go to Firestore, staff
review them in a small admin dashboard, and approved applicants become testers
with an explicit active / not-active state.

## The data model

A public intake queue, and a roster that lives on the user's own account:

```
requests/{requestId}        public intake, append-only from the visitor's view
  name, email, consent, experienceCategory, source, userAgent
  status        pending | approved | rejected
  createdAt, updatedAt, reviewedBy, reviewedAt, note
  testerId, userId          set on approval

users/{authUid}             the account; doc id IS the Firebase Auth uid
  email, displayName, createdAt
  friends, friendRequests, lastLogin        owned by the main app, not by us
  tester        { ... }     <-- the tester record, a nested MAP
  testerHistory [ { ... } ] <-- past tenures, appended on removal

users/{authUid}/feedback/{feedbackId}   what that tester asked for
  title, body, area, status, period
  testerId, email, createdAt, updatedAt

testerIndex/{sha256(email)}  email -> userId pointer, so a tester can find
                             their own record without being able to list
requestEmails/{sha256(email)}           pending/approved/inactive duplicate marker
meta/testerCounter                      sequential tester-number counter
audit/{entryId}                         append-only trail of staff actions
```

### How a tester signs in

`testerIndex/{sha256(email)}` holds only a `userId`, so it is safe to read
openly while `list` stays denied — the key is a hash, so it leaks nothing, and it
cannot be enumerated. The portal resolves a signed-in tester's own record through
it in two reads, never accepting a caller-supplied tester id.

The Worker writes this pointer on every approval. Two things can leave a tester
unable to sign in: no pointer at all, or a **stale** one left from before the move
to user documents that still names a `t_...` document. Both are repaired either by
re-approving or by the backfill:

```
node scripts/check-tester-index.js              # who is stuck
node scripts/backfill-tester-index.js            # dry run
node scripts/backfill-tester-index.js --apply    # write the pointers
```

The backfill only ever fills gaps — a correct pointer is left alone — and touches
nothing but `testerIndex`.

### Feedback

Tester requests live at `users/{uid}/feedback/{id}` — under the user document
rather than under `tester`, because `tester` is a map and has no path of its own.
The path carries the ownership check: a tester can only write beneath their own
account, and only while they still hold a `tester` map, so removal revokes
feedback access without touching a rule.

`status` is fixed to `submitted` by the rules. A tester cannot mark their own
request as shipped, and cannot edit or delete a submission afterwards — the
programme's record of what was asked for is staff-owned.

The `tester` map:

```
  id, requestId, userId, name, email
  status        pending | accepted | rejected | revoked   <-- lifecycle
  appliedAt, acceptedAt, testerNumber
  statusChangedAt, statusChangedBy
  active         <-- the active / not-active flag
  activatedAt, deactivatedAt, deactivatedBy, deactivationReason
  wallet         { issuerId, classId, accountId, lastIssuedAt }
  activity       { lastPeriod, comments, reviews }

users/{authUid}/activity/{YYYY-MM}   immutable per-period counts
```

### Why the tester lives on the user document

The tester is not its own document; it is a `tester` map on the account that
owns it. Three consequences, all deliberate:

- **The identity is the Auth uid.** Approval has to resolve — and where none
  exists, create — a Firebase account, because that uid is the document key. The
  dashboard therefore asks for a password when approving someone new, so the
  applicant ends up with an account they can actually sign in to. Two admins
  approving the same new applicant at once both lose the create race safely:
  the loser re-resolves by email rather than creating a second identity.
- **Writes must be masked.** Lifecycle updates target `tester.<field>`, never the
  whole document, so a wallet reissue cannot disturb `friends` or `lastLogin`.
  The Firestore REST body is nested while the updateMask path is dotted, and the
  two have to agree — sending `{"tester.wallet": …}` instead would create a
  literal field name containing a dot and silently store nothing.
- **The roster is a client-side filter.** `active` is nested, so it is not an
  indexable top-level field. The dashboard lists `users` (staff only) and
  filters in memory; the two `testers` composite indexes are gone.

### Membership is field existence, not a flag

Removal **moves** the record: the snapshot is appended to `testerHistory` and the
`tester` map is deleted, in one transaction with the audit entry and the
duplicate-marker release. A `removed` flag would have been the smaller change,
but `tester` is a field other code reads, and a flagged-but-present tester still
reads as "in the programme". Deleting the field makes membership a plain
`user.tester != null` check with no flag left to drift.

The account itself is **not** deleted, so a former tester can sign in and apply
again — which takes a fresh number, since the counter is never rewound.

### Tester status vs. the active flag

`status` is the lifecycle; `active` is the boolean the rules, queries and
Wallet logic already depend on. They are written together and cannot drift:

| status | active | meaning |
|---|---|---|
| `pending` | `false` | applied, not yet reviewed |
| `accepted` | `true` | in the program |
| `rejected` | `false` | turned down; no benefits granted |
| `revoked` | `false` | was accepted, now removed — Wallet pass is REVOKED |

`setTesterStatus` is the everyday toggle (accepted <-> revoked) and also covers
transitions about the application itself, notably `rejected`.

### Sequential tester numbers

Assigned on acceptance, inside a transaction on `meta/testerCounter`. A plain
read-then-write would hand the same number to two admins accepting at the same
moment — `tests/tester-status.test.js` includes a control test proving the naive
version collapses to a single number under concurrency while the transactional
one yields a clean 1..25. A number is never reassigned, so a tester keeps theirs
even if later revoked.

**Why the split.** A request is a transient lead; a tester is a persistent
program member. Keeping them apart means the public intake queue never carries
program state, and an applicant can re-apply without disturbing an existing
tester record.

**Why `active` is a boolean.** Deactivation drives the Google Wallet pass state,
so an inactive tester receives a `REVOKED` card rather than a live one.

## Who can write what

| Path | Written by | Enforced by |
|---|---|---|
| `requests` create | public visitor | `firestore.rules` — exact field allowlist |
| `requests` decide | Cloudflare Worker `/accept` | `admin` claim, re-checked in code |
| `users.tester` lifecycle | Cloudflare Worker | self-updates limited to an app-field allowlist |
| `users.tester.active` | Cloudflare Worker `/tester-status` | `admin` claim + mandatory reason |
| Firebase Auth account | Cloudflare Worker `/accept` | `admin` claim; only when no account exists |
| `audit` | Cloudflare Worker admin routes | `allow write: if false` |

Because the tester record is a nested map on a document the user can otherwise
update for themselves, the rule that matters is narrower than "clients cannot
write here": `diff()` compares before and after and rejects any change to a key
the user does not own. `tests/rules.test.js` proves a tester cannot flip their
own `active` flag, claim a number, rewrite `testerHistory`, or delete the `tester`
map to erase the record — while still being able to update `lastLogin`.

The Worker uses Firebase service-account access and therefore **bypasses**
Firestore rules for admin writes. It verifies the caller's Firebase ID token and
`admin` claim before each admin route.

## Public form

`js/signup.js` is a plain ES module loading the SDK from the gstatic CDN — no
bundler, no build step, so the site still deploys to GitHub Pages unchanged.

The rules pin the public write tightly:

- `status` must be exactly `"pending"` — a visitor cannot self-approve
- `experienceCategory` must be `developer`, `everyday_user`, or `new_to_technology`
- `createdAt` must equal `request.time` — blocks timestamp spoofing
- a `website` honeypot must be empty — hidden from humans, filled by bots
- `hasOnly([...])` — no extra fields can be smuggled in
- no `list` anywhere — applicant emails are never enumerable

The request and its email marker are created in one Firestore transaction, so
simultaneous submissions with the same address cannot create duplicate
requests. Rejection keeps the original request and its review fields, while the
Worker atomically releases the marker only when it still points to that exact
request. Pending, approved, and inactive applicants remain blocked; removed
testers and rejected applicants may apply again.

## Setup

```bash
npm install
npm i --prefix functions

# 1. Point the project at Firebase
#    .firebaserc already lists crp-cuby-display; change it if needed

# 2. Paste your web config into js/firebase-config.js and
#    admin/js/firebase-config.js  (see the .example.js templates)

# 3. Create the Firestore database and Auth provider (Email/Password), then:
npm run deploy:rules

# 4. Configure the Cloudflare Worker secrets (see crp-tester-email/README.md)
#    and deploy it:
npm --prefix crp-tester-email run deploy

# 5. Create a staff user in Firebase console > Authentication, then:
node scripts/set-admin-claim.js you@crp.com
```

Publish the updated static site to GitHub Pages as part of the same release as
the Firestore rules: the rules now require the experience category that the
updated form submits.

### Google Wallet credentials

The Worker pass builder reads the Google Wallet service account from a Worker
secret, never from a file in the repo:

```bash
npx wrangler secret put GOOGLE_WALLET_SERVICE_ACCOUNT_JSON
```

The local `test:wallet` script still uses `GOOGLE_APPLICATION_CREDENTIALS_JSON`
for its separate legacy Functions implementation.

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
npm test              # exports, email, and 27 rules tests
npm run test:worker   # Cloudflare Worker suite
npm run test:rules    # rules tests against the Firestore emulator
npm run test:wallet   # JWT shape, and pass state follows `active`
npm run test:e2e      # real form submission, category, duplicate gate, sent.html
npm run emulators     # local Firestore + Auth + Functions
npm run dev           # static preview on :8900
```

`tests/rules.test.js` covers the guarantees that matter: a visitor can create a
request and nothing else, a user can update their own app fields but never their
`tester` map, a user can read only their own document, and the audit trail is
unreachable from any client.

`tests/e2e-signup.js` drives a real browser through the form and asserts the
document that lands in Firestore, that the email is normalised, that a repeat
submission is refused, the experience category is stored, and no `users` document
is created — the visitor-facing half of the model is unchanged. The rules tests
also exercise concurrent submissions and reapplication after rejection.

## Admin dashboard

`/admin` — sign in with an account holding the `admin` claim. Lists the request
queue and the tester roster side by side, with experience categories in request
rows and details, approve/reject, the active toggle, and one-click wallet pass
issuance.

The dashboard never writes to Firestore directly; every mutation goes through
the authenticated Cloudflare Worker, so a tampered client cannot approve a
request or flip a status.

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
| `js/signup.js` | Calls the Worker after the request transaction succeeds |
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