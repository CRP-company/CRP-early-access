// Cloudflare Worker endpoint for confirmation emails.
//
// This is PUBLIC and safe to commit — it is a URL, not a credential. The
// Resend API key never leaves the Worker; it is stored as a Worker secret.
//
// After your first deploy, `wrangler deploy` prints the workers.dev URL.
// Put it here. The Worker only accepts requests from
// https://crp-company.github.io, so this must match the origin the site is
// served from.
window.CRP_EMAIL_WORKER_URL = "https://crp-tester-email.YOUR-SUBDOMAIN.workers.dev/send";
