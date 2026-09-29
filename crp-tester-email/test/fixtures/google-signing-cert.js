/**
 * A genuine Firebase ID-token signing certificate, captured from Google's
 * live x509 endpoint:
 *
 *   https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com
 *
 * This is PUBLIC key material. Google publishes the token signing key for
 * every project so anyone can verify ID tokens; a certificate contains only
 * a public key, never a private one.
 *
 * It is a real X.509 certificate, NOT a bare SPKI wearing certificate
 * armour. Tests must use this shape: the endpoint serves certificates, and
 * feeding one straight to importKey('spki', ...) is exactly the bug that
 * made every authenticated admin request fail with 'Invalid SPKI input'.
 */

/** The kid this certificate is published under. */
export const REAL_KID = "6f7de798eee8a24ebade6f228411220c8669010d";

/** The certificate, PEM-encoded, exactly as the endpoint returns it. */
export const REAL_CERTIFICATE_PEM = "-----BEGIN CERTIFICATE-----\nMIIDHDCCAgSgAwIBAgIIFFdImQ/V0kUwDQYJKoZIhvcNAQEFBQAwMTEvMC0GA1UE\nAwwmc2VjdXJldG9rZW4uc3lzdGVtLmdzZXJ2aWNlYWNjb3VudC5jb20wHhcNMjYw\nNTA0MTc0NzI3WhcNMjcwNTA0MTc0NzI3WjAxMS8wLQYDVQQDDCZzZWN1cmV0b2tl\nbi5zeXN0ZW0uZ3NlcnZpY2VhY2NvdW50LmNvbTCCASIwDQYJKoZIhvcNAQEBBQAD\nggEPADCCAQoCggEBAOKOpTkKGfjHH1ny5ZJXKag63eWg9RvVlfY3SgKULip4mwM1\nHuCIY0aYoXEdKdVFgS/+mPOPDfSSjcYbl1/+QTZH0mBiqatIgQGegNf5naIkF9jd\nSxazYShP8cgjOkRckaFdrMvEa/mNOO5wTk6AEMbUR+V1M8auOAiqeAGOvTTgbOJl\nbRB9NufzI8WbysbEPRtgqDYY9WxXcrukkacecYsaLkj0qy14DTZXt08NB+ZlYnHQ\n2+qoEo33lMMm67gpBTPe3mu4L9CrZ9qDxzH7WqMz+7zGeA9FqDwyMu9UONE+Ssbs\nxYN6dtw12vC1S6ueAzdGgWCOTB8njBAvkrYJ0gMCAwEAAaM4MDYwDAYDVR0TAQH/\nBAIwADAOBgNVHQ8BAf8EBAMCB4AwFgYDVR0lAQH/BAwwCgYIKwYBBQUHAwIwDQYJ\nKoZIhvcNAQEFBQADggEBALxRVxyzG7sUYwBdUGOQ8wWt7o/1tvgAVKa9VpgzzlHb\nW4irMEOCetKswJFN4KieFqfUcwsKucRiDZRm9iIrPTyI3AhH9Yu7UY7lrqkYZ//b\nv1Q+oj1YqYcwHcyhuykzQIf+eq1reBWhG0GaDfxTdIeQkcYBZ5nVNICBXU2QVJLE\nqjM89ncbpinVTzI7kH1uZvqMDeL7/su6GSvoi4oXokOauGcaogwbbE+HK//QMOMK\nXSu2FfrwU5Vua5Mx37jQTnM5ruVJQvnNYsd9QAMfhd7cUMMYuIAW1sQMSk5/F95Q\nQCCW8kDKq9yAOrfHSS2zw5pqsIc/HC/bD3cW9J0CYK8=\n-----END CERTIFICATE-----\n";
