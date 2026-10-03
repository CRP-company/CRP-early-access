/**
 * Run the REAL Cloudflare Worker locally, against the Firebase emulators.
 *
 * Why this exists
 * ---------------
 * The tester dashboard cannot be exercised end to end by loading the deployed
 * Worker, because two of its outbound dependencies point at production and offer
 * no emulator seam:
 *
 *   1. auth.js fetches Google's live x509 signing keys (KEYS_URL) to verify the
 *      caller's ID token signature.
 *   2. firestore-rest.js hardcodes https://firestore.googleapis.com.
 *
 * Changing either to add emulator support would mean editing the Worker itself,
 * which is out of scope for a test. So this harness loads the UNMODIFIED worker
 * module (`src/index.js`) into Node and redirects only its three outbound calls:
 *
 *   - Google's x509 key endpoint   -> a keypair generated here. This stands in
 *     for "whatever service signed the token", and is the only piece of the
 *     crypto chain this harness supplies.
 *   - Google's OAuth token endpoint -> a stub. Never leaves the machine.
 *   - Firestore REST                -> the real Firestore emulator, on localhost.
 *
 * Everything else is the real thing: real request parsing, real CORS handling,
 * the real `requireUser()` signature and issuer checks, the real
 * `findTesterByEmail()` roster resolution, the real `/tester-me` handler. The
 * roster the Worker reads is genuinely seeded into the Firestore emulator.
 *
 * The ID token
 * ------------
 * The Firebase Auth emulator signs tokens with `algorithm: "none"` — unsigned,
 * with no keypair to publish. `auth.js` rejects anything that is not RS256, so an
 * emulator token can never pass production signature verification, by design. The
 * test therefore has this harness mint a correctly-signed RS256 token and
 * substitutes it at the token-mint boundary (see tests/e2e-tester-login.js).
 * From there on it is a genuine, verifiable RS256 token and the Worker verifies
 * it for real.
 */

import { createServer } from "node:http";
import { webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

const WORKER_ENTRY = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../crp-tester-email/src/index.js",
);

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Firestore field-value encoding, for seeding the emulator from the test. */
export function encodeField(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeField) } };
  if (typeof value === "object") return { mapValue: { fields: encodeFields(value) } };
  throw new TypeError(`Cannot encode ${typeof value}`);
}

/**
 * A plain object -> a Firestore field map.
 *
 * This is what a document body's `fields` wants. encodeField() is the wrong tool
 * for a whole document: it would wrap the object in a mapValue, producing
 * `{fields: {mapValue: {fields: …}}}`, which the emulator rejects.
 */
export function encodeFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    fields[key] = encodeField(value);
  }
  return fields;
}

/**
 * Boot the worker behind a local HTTP server.
 *
 * @returns {Promise<{url: string, port: number, mintToken: Function, close: Function}>}
 */
export async function startWorkerHarness({
  port = 8901,
  projectId,
  allowedOrigin,
  firestoreOrigin,
} = {}) {
  if (!projectId) throw new Error("startWorkerHarness needs a projectId.");
  if (!firestoreOrigin) throw new Error("startWorkerHarness needs a firestoreOrigin.");

  // The real module, loaded from disk. Nothing is patched at the source level;
  // only its outbound `fetch` is redirected below.
  const worker = (await import(pathToFileURL(WORKER_ENTRY).href)).default;

  const keyPair = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  // oauth.js signs a real JWT assertion with this before asking for a bearer
  // token, so it must be a genuine PKCS#8 PEM. The token request itself is
  // stubbed below, so this key never authenticates to anything real.
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const serviceAccountJson = JSON.stringify({
    type: "service_account",
    project_id: projectId,
    client_email: "harness@crp-cuby-display.iam.gserviceaccount.com",
    private_key:
      "-----BEGIN PRIVATE KEY-----\n" +
      Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n").trim() +
      "\n-----END PRIVATE KEY-----\n",
  });

  const env = {
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson,
    // The tester dashboard's origin, so the CORS preflight is exercised for real
    // rather than short-circuited.
    ALLOWED_ORIGINS: allowedOrigin,
    ADMIN_EMAILS: "staff@example.com",
  };

  /** Mint a genuinely-signed RS256 ID token, as Google would hand one out. */
  async function mintToken({ uid, email, admin = false }) {
    const header = b64url(
      Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "harness-k1" })),
    );
    const payload = b64url(
      Buffer.from(
        JSON.stringify({
          iss: `https://securetoken.google.com/${projectId}`,
          aud: projectId,
          sub: uid,
          user_id: uid,
          email,
          email_verified: true,
          ...(admin ? { admin: true } : {}),
          // Real Firebase ID tokens always carry a `firebase` claim. The Auth
          // emulator reads `payload.firebase.tenant` on requests that present an
          // idToken (the SDK's post-sign-in `accounts:lookup` does exactly that),
          // and throws on a token without it. Mirroring the claim keeps that
          // lookup working exactly as it does against production.
          firebase: {
            identities: {},
            sign_in_provider: "password",
          },
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
    );
    const signature = await webcrypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${b64url(signature)}`;
  }

  // ---- redirect the worker's outbound calls, and only those ----------------
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url || input);

    // 1. Google's signing keys -> the keypair this harness minted. auth.js imports
    //    each entry as SPKI, tolerating either a bare key or a certificate.
    if (url.includes("robot/v1/metadata/x509")) {
      const spki = await webcrypto.subtle.exportKey("spki", keyPair.publicKey);
      const pem =
        "-----BEGIN CERTIFICATE-----\n" +
        Buffer.from(spki).toString("base64").replace(/(.{64})/g, "$1\n").trim() +
        "\n-----END CERTIFICATE-----\n";
      return new Response(JSON.stringify({ "harness-k1": pem }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. OAuth token exchange -> stubbed. The worker would otherwise sign an
    //    assertion and post it to Google, which must never happen in a test.
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "harness-stub", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 3. Firestore REST -> the emulator, with its fixed admin token. The worker's
    //    own service-account bearer is replaced by the emulator's.
    if (url.includes("firestore.googleapis.com")) {
      const target = url.replace("https://firestore.googleapis.com", firestoreOrigin);
      const headers = new Headers(init.headers || {});
      headers.set("Authorization", "Bearer owner");
      headers.delete("Content-Length");
      return realFetch(target, { ...init, headers });
    }

    return realFetch(input, init);
  };

  // ---- serve it over HTTP so the browser gets real CORS -------------------
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
        else headers.set(key, value);
      }
      // Let undici compute its own host/content-length.
      headers.delete("host");

      const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers,
        body: body.length ? body : undefined,
      });

      const response = await worker.fetch(request, env);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(await response.text());
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: `harness: ${error.message}` }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    url: `http://localhost:${port}`,
    port,
    mintToken,
    close: () =>
      new Promise((resolve) => {
        globalThis.fetch = realFetch;
        server.close(resolve);
      }),
  };
}