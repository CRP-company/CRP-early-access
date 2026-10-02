// Cloudflare Worker endpoint for the tester dashboard.
//
// This is PUBLIC and safe to commit — it is a URL, not a credential. The caller's
// Firebase ID token travels in the Authorization header, so the Worker can tell
// which tester is asking and resolve their record from their email. The service
// account key and the Resend key stay inside the Worker as encrypted secrets.
//
// The Worker only accepts requests from https://crp-company.github.io, the origin
// this site is served from. If the site moves, update ALLOWED_ORIGINS in
// crp-tester-email/wrangler.jsonc to match.
window.CRP_WORKER_URL = "https://crp-tester-email.atronamir5.workers.dev";