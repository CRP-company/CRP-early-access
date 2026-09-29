/**
 * Extract the SubjectPublicKeyInfo (SPKI) from an X.509 certificate.
 *
 * Why this exists
 * ---------------
 * The Firebase signing-key endpoint
 * (`robot/v1/metadata/x509/securetoken@system.gserviceaccount.com`) returns
 * **X.509 certificates**, not bare public keys. Each is roughly 800 bytes of
 * DER beginning `30 82 ...`, wrapping the ~294-byte SPKI that WebCrypto's
 * `importKey("spki", …)` actually wants.
 *
 * Handing the whole certificate to `importKey("spki", …)` fails with a
 * `DataError` — surfaced by Cloudflare Workers as `Invalid SPKI input` — so
 * every authenticated `/accept` and `/tester-status` call returned HTTP 500.
 *
 * This module does the small amount of DER walking needed to pull the SPKI out
 * of the certificate, using no Node built-ins: Cloudflare Workers has no
 * `node:crypto`.
 *
 * Certificate ::= SEQUENCE {
 *   tbsCertificate       TBSCertificate,
 *   signatureAlgorithm   AlgorithmIdentifier,
 *   signatureValue       BIT STRING }
 *
 * TBSCertificate ::= SEQUENCE {
 *   version         [0] EXPLICIT Version DEFAULT v1,   -- optional, context tag
 *   serialNumber        CertificateSerialNumber,
 *   signature           AlgorithmIdentifier,
 *   issuer              Name,
 *   validity            Validity,
 *   subject             Name,
 *   subjectPublicKeyInfo SubjectPublicKeyInfo,          -- <-- what we want
 *   ... }
 *
 * Only enough of the grammar is parsed to reach subjectPublicKeyInfo. The
 * fields before it are skipped by walking element boundaries, never by trusting
 * a fixed offset, so the parser is not sensitive to the optional version tag or
 * to any future field inserted before the key.
 */

/** DER tag numbers used while walking the certificate. */
const SEQUENCE = 0x30;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const CONTEXT_0 = 0xa0; // [0] EXPLICIT version

/**
 * Read one DER TLV header at `offset`.
 *
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {{tag: number, headerLength: number, length: number, end: number}}
 *   `end` is the index just past this element's contents.
 */
function readTlv(bytes, offset) {
  if (offset >= bytes.length) throw new Error("DER: unexpected end of input");

  const tag = bytes[offset];

  // High-tag-number form (tag number > 30) is multi-byte. Nothing in a
  // certificate uses it, so reject rather than misparse.
  if ((tag & 0x1f) === 0x1f) throw new Error("DER: multi-byte tags are not supported");

  let cursor = offset + 1;
  if (cursor >= bytes.length) throw new Error("DER: truncated length");

  let length = bytes[cursor];
  cursor += 1;

  if (length & 0x80) {
    // Long form: the low bits give the number of length bytes that follow.
    const count = length & 0x7f;
    if (count === 0) throw new Error("DER: indefinite length is not valid DER");
    if (count > 4) throw new Error("DER: length too large");
    if (cursor + count > bytes.length) throw new Error("DER: truncated long length");

    length = 0;
    for (let i = 0; i < count; i += 1) {
      length = (length << 8) | bytes[cursor];
      cursor += 1;
    }
  }

  return { tag, headerLength: cursor - offset, length, end: cursor + length };
}

/**
 * Extract the SPKI DER from an X.509 certificate's DER bytes.
 *
 * @param {ArrayBuffer|Uint8Array} certificateDer
 * @returns {Uint8Array} The SubjectPublicKeyInfo, ready for importKey("spki").
 * @throws {Error} If the bytes are not a well-formed RSA certificate.
 */
export function extractSpkiFromCertificate(certificateDer) {
  const bytes =
    certificateDer instanceof Uint8Array
      ? certificateDer
      : new Uint8Array(certificateDer);

  const cert = readTlv(bytes, 0);
  if (cert.tag !== SEQUENCE) throw new Error("X.509: certificate is not a SEQUENCE");
  if (cert.end > bytes.length) throw new Error("X.509: certificate is truncated");

  // Certificate.tbsCertificate
  const tbsStart = cert.headerLength;
  const tbs = readTlv(bytes, tbsStart);
  if (tbs.tag !== SEQUENCE) throw new Error("X.509: tbsCertificate is not a SEQUENCE");

  // Walk the tbsCertificate fields, stopping at subjectPublicKeyInfo.
  // `headerLength` is relative to each element's own start, so the running
  // cursor is always an absolute buffer offset.
  let cursor = tbs.end - tbs.length; // == tbsStart + tbs.headerLength
  const tbsEnd = tbs.end;

  // Optional `version [0] EXPLICIT`.
  if (cursor < tbsEnd && bytes[cursor] === CONTEXT_0) {
    const version = readTlv(bytes, cursor);
    cursor = version.end;
  }

  // serialNumber, signature, issuer, validity, subject — five fields before
  // the key. They are skipped by boundary, not by assuming a size.
  for (let i = 0; i < 5; i += 1) {
    if (cursor >= tbsEnd) throw new Error("X.509: tbsCertificate ended before the public key");
    cursor = readTlv(bytes, cursor).end;
  }

  // subjectPublicKeyInfo
  const spki = readTlv(bytes, cursor);
  if (spki.tag !== SEQUENCE) {
    throw new Error("X.509: subjectPublicKeyInfo is not a SEQUENCE");
  }
  if (spki.end > tbsEnd) throw new Error("X.509: subjectPublicKeyInfo overruns tbsCertificate");

  return bytes.subarray(cursor, spki.end);
}

/**
 * Decode a PEM certificate to DER bytes.
 *
 * @param {string} pem
 * @returns {Uint8Array}
 */
export function pemCertificateToDer(pem) {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");

  if (!body) throw new Error("X.509: certificate PEM is empty");

  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * True when the DER is already a bare SubjectPublicKeyInfo rather than a
 * certificate.
 *
 * A certificate's outer SEQUENCE contains a SEQUENCE (tbsCertificate) whose
 * first element is a context [0] version or an INTEGER serialNumber. A bare
 * SPKI's outer SEQUENCE contains an AlgorithmIdentifier SEQUENCE followed by a
 * BIT STRING. So a first inner element that is neither of those means the bytes
 * are not a certificate.
 *
 * @param {Uint8Array} der
 * @returns {boolean}
 */
export function looksLikeCertificate(der) {
  try {
    const outer = readTlv(der, 0);
    if (outer.tag !== SEQUENCE) return false;

    // A certificate's second element is tbsCertificate (a SEQUENCE); a bare
    // SPKI's second element is the BIT STRING holding the public key.
    const second = readTlv(der, outer.headerLength);
    if (second.tag !== SEQUENCE) return false;

    // tbsCertificate's own first field. `headerLength` is relative to each
    // element's start, so add the tbs absolute offset.
    const tbsFirst = readTlv(der, second.end - second.length);
    return tbsFirst.tag === CONTEXT_0 || tbsFirst.tag === INTEGER;
  } catch {
    return false;
  }
}
