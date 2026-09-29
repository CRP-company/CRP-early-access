// Cloudflare Worker endpoint for the acceptance flow.
//
// Copy to `worker-config.js` and set your deployed Worker URL. The base URL is
// enough — the dashboard appends `/accept` and `/tester-status` itself.
//
// Public and safe to commit: this is a URL, not a credential.
window.CRP_WORKER_URL = "https://crp-tester-email.YOUR-SUBDOMAIN.workers.dev";
