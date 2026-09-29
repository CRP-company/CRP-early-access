// Cloudflare Worker endpoint for confirmation emails.
//
// This is PUBLIC and safe to commit — it is a URL, not a credential. The
// Resend API key lives only inside the Worker as an encrypted secret
// (npx wrangler secret put RESEND_API_KEY) and never reaches this file.
//
// The Worker only accepts POSTs from https://crp-company.github.io, which is
// the origin this site is served from. If you move the site, update
// ALLOWED_ORIGINS in crp-tester-email/wrangler.jsonc to match.
window.CRP_EMAIL_WORKER_URL =
  "https://crp-tester-email.atronamir5.workers.dev/send";

