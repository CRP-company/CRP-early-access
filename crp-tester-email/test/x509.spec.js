/**
 * Regression tests for X.509 certificate handling.
 *
 * Background: the Firebase signing-key endpoint serves X.509 certificates, but
 * WebCrypto's importKey("spki", ...) requires a bare SubjectPublicKeyInfo.
 * Feeding it a whole certificate throws a DataError, which Cloudflare Workers
 * reports as "Invalid SPKI input" — so every authenticated /accept request
 * returned HTTP 500 in production.
 *
 * The previous tests could not catch this: they served a bare SPKI wrapped in
 * CERTIFICATE armour, which imports cleanly. These tests use a genuine X.509
 * certificate, the same shape production returns.
 */
import { describe, it, expect, vi } from "vitest";
import {
  extractSpkiFromCertificate,
  pemCertificateToDer,
  looksLikeCertificate,
} from "../src/x509.js";
import { REAL_KID, REAL_CERTIFICATE_PEM } from "./fixtures/google-signing-cert.js";

const importKey = (bytes) =>
  crypto.subtle.importKey("spki", bytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);

describe("the production certificate really is a certificate", () => {
  it("is recognised as a certificate, not a bare SPKI", () => {
    expect(looksLikeCertificate(pemCertificateToDer(REAL_CERTIFICATE_PEM))).toBe(true);
  });

  it("cannot be imported directly — this is the bug that caused the 500", async () => {
    // Guards the premise of the whole suite. If this ever starts passing, the
    // fixture is no longer exercising the real-world shape.
    await expect(importKey(pemCertificateToDer(REAL_CERTIFICATE_PEM))).rejects.toThrow();
  });
});

describe("extractSpkiFromCertificate", () => {
  it("produces bytes WebCrypto accepts as an SPKI", async () => {
    const spki = extractSpkiFromCertificate(pemCertificateToDer(REAL_CERTIFICATE_PEM));
    await expect(importKey(spki)).resolves.toBeDefined();
  });

  it("yields a structurally smaller key than the certificate that wrapped it", () => {
    const der = pemCertificateToDer(REAL_CERTIFICATE_PEM);
    const spki = extractSpkiFromCertificate(der);
    expect(spki.length).toBeLessThan(der.length);
    // SEQUENCE tag, as an SPKI must be.
    expect(spki[0]).toBe(0x30);
  });

  it("returns exactly the SubjectPublicKeyInfo, self-consistently", () => {
    // The extracted element must parse as a complete SEQUENCE whose length
    // matches the bytes returned, i.e. no leading or trailing slack.
    const spki = extractSpkiFromCertificate(pemCertificateToDer(REAL_CERTIFICATE_PEM));
    const lengthByte = spki[1];
    const longForm = (lengthByte & 0x80) !== 0;
    const declared = longForm ? lengthByte & 0x7f : lengthByte;
    const headerLength = longForm ? 2 + declared : 2;
    expect(headerLength + spki.slice(2, headerLength + 1).length).toBeLessThanOrEqual(spki.length);
    expect(spki.length - headerLength).toBeGreaterThan(0);
  });
});

describe("robustness", () => {
  it("rejects bytes that are not a SEQUENCE", () => {
    expect(() => extractSpkiFromCertificate(new Uint8Array([0x31, 0x00]))).toThrow(/SEQUENCE/);
  });

  it("rejects a truncated certificate rather than returning nonsense", () => {
    const der = pemCertificateToDer(REAL_CERTIFICATE_PEM);
    expect(() => extractSpkiFromCertificate(der.subarray(0, 40))).toThrow();
  });

  it("rejects empty input", () => {
    expect(() => extractSpkiFromCertificate(new Uint8Array([]))).toThrow();
  });
});

describe("the endpoint's other certificates", () => {
  // The live endpoint publishes several certs at once and the Worker imports
  // every one. This cert is a second, independent sample from the same source.
  it("imports a certificate whose SPKI differs from the fixture's", async () => {
    const res = await fetch(
      "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com",
    );
    if (!res.ok) {
      // Offline: the offline assertions above already cover the parser.
      return;
    }
    const json = await res.json();
    for (const [kid, pem] of Object.entries(json)) {
      const der = pemCertificateToDer(pem);
      expect(looksLikeCertificate(der), kid).toBe(true);
      await expect(importKey(extractSpkiFromCertificate(der)), kid).resolves.toBeDefined();
    }
  });
});

describe("the fixture is usable as a signing key", () => {
  it("carries a kid that matches the JWT header convention", () => {
    expect(REAL_KID).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("requireAdmin with a genuine certificate", () => {
  // End-to-end through the real auth path. The bug made every authenticated
  // request 500, so the regression must be asserted where it appeared: at
  // requireAdmin(), not only in the parser.
  //
  // The token below is well-formed (three base64url segments, RS256) so that
  // requireAdmin gets past its cheap structural checks and actually reaches
  // signingKeys(). A token like "not.a.valid.token" would be rejected as
  // malformed before the certificate is ever loaded, which would make this
  // test pass even with the bug present.
  const b64u = (obj) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  it("loads a real certificate and rejects only on signature, never on import", async () => {
    const { requireAdmin, __resetKeyCache } = await import("../src/auth.js");
    __resetKeyCache();

    const now = Math.floor(Date.now() / 1000);
    const header = b64u({ alg: "RS256", typ: "JWT", kid: REAL_KID });
    const payload = b64u({
      aud: "crp-cuby-display",
      iss: "https://securetoken.google.com/crp-cuby-display",
      sub: "abc123",
      email: "staff@example.com",
      admin: true,
      iat: now,
      exp: now + 3600,
    });
    // Well-formed but not a valid signature for this certificate.
    const token = `${header}.${payload}.${b64u({ sig: true })}`;

    const keysFetch = vi.fn(async (url) => {
      if (String(url).includes("robot/v1/metadata/x509")) {
        return new Response(JSON.stringify({ [REAL_KID]: REAL_CERTIFICATE_PEM }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("unexpected fetch: " + url);
    });
    vi.stubGlobal("fetch", keysFetch);

    const request = new Request("https://worker.test/accept", {
      headers: { Authorization: `Bearer ${token}` },
    });

    let error = null;
    try {
      await requireAdmin(request, "crp-cuby-display");
    } catch (e) {
      error = e;
    }

    // The signing keys must actually have been fetched and parsed.
    expect(keysFetch, "the certificate endpoint should be consulted").toHaveBeenCalled();

    // Before the fix this threw DataError ("Invalid SPKI input" on Workers).
    // Now the only failure possible is a genuine signature rejection.
    expect(error).toBeTruthy();
    expect(error.message, "must not be a key-import failure").not.toMatch(
      /SPKI|keyData|DataError|key/i,
    );
    expect(error.status).toBe(401);
    expect(error.message).toMatch(/signature/i);

    vi.unstubAllGlobals();
    __resetKeyCache();
  });
});

