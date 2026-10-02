// Copy to worker-config.js and point it at your Worker.
//
// PUBLIC and safe to commit — it is a URL, not a credential. Tester identity is
// carried by the Firebase ID token in the Authorization header; the Resend key and
// the service-account key never leave the Worker.
//
// Until this is set, signing in still works but the dashboard cannot load, so the
// page says so rather than appearing broken.
window.CRP_WORKER_URL = "https://crp-tester-email.YOUR-SUBDOMAIN.workers.dev";