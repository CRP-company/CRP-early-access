// Cloudflare Worker endpoint for the acceptance flow.
//
// This is PUBLIC and safe to commit — it is a URL, not a credential. Admin
// identity is carried by the Firebase ID token in the Authorization header;
// the Resend key and the service-account key never leave the Worker.
//
// Until this is set, approving and rejecting are unavailable and the rest of
// the dashboard keeps working. That is deliberate: a missing endpoint must not
// break reviewing the queue.
window.CRP_WORKER_URL = "https://crp-tester-email.atronamir5.workers.dev";
