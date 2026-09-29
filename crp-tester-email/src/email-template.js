/**
 * HTML email template for the "application received" acknowledgement.
 *
 * Ported from functions/src/email-template.js. The escaping, greeting
 * validation and copy are unchanged, so the existing test suite still applies.
 * The only difference is that configuration arrives as an `env`-shaped object
 * rather than process.env, since Workers have no process.
 *
 * Email clients are a hostile rendering environment, so this deliberately uses
 * table-based layout and inline CSS. No flexbox, no grid, no external CSS, no
 * web fonts — Gmail in particular strips <style> in some contexts and ignores
 * modern layout entirely. Every rule that matters is inline.
 */

const DEFAULTS = {
  logoUrl: "https://i.postimg.cc/K8zf4q4q/CRPlogo.png",
  heroUrl:
    "https://www.image2url.com/r2/default/images/1776869274976-74e932ff-18d5-462e-885b-c6ed42d42bcf.png",
  siteUrl: "https://crp-company.github.io/CRP-early-access/",
  privacyUrl: "https://crp-company.github.io/CRP-Privacy-policy/",
};

/**
 * Escape a value for interpolation into HTML.
 *
 * `name` comes straight from a public form, so this is a genuine XSS guard for
 * the HTML part of the email — without it, a request submitted with
 * `name: <img onerror=...>` would execute in the recipient's mail client.
 */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

/**
 * Only the first name, and only if it genuinely looks like a name.
 *
 * This validates rather than sanitises: a token containing anything outside
 * letters, digits, apostrophes or hyphens is rejected outright and the generic
 * "there" is used. Stripping the bad characters instead would mangle input into
 * an invented name — "<b>" becoming "Hi b" — which reads as though we mangled
 * someone's real name.
 */
export function greetingFor(name) {
  const first = String(name ?? "").trim().split(/\s+/)[0] || "";
  if (!first) return "there";
  if (first.length > 40) return "there";
  return /^[\p{L}\p{N}'-]+$/u.test(first) ? first : "there";
}

/**
 * Build the acknowledgement email.
 *
 * @param {object} data
 * @param {string} data.name    Applicant's submitted name.
 * @param {string} data.email   Recipient address.
 * @param {object} [config]     Overrides for the asset URLs.
 * @returns {{subject: string, html: string, text: string}}
 */
export function buildApplicationReceivedEmail({ name, email }, config = {}) {
  const LOGO_URL = config.logoUrl || DEFAULTS.logoUrl;
  const HERO_IMAGE_URL = config.heroUrl || DEFAULTS.heroUrl;
  const SITE_URL = config.siteUrl || DEFAULTS.siteUrl;
  const PRIVACY_URL = config.privacyUrl || DEFAULTS.privacyUrl;

  const greeting = escapeHtml(greetingFor(name));
  const safeEmail = escapeHtml(email);
  const subject = "CRP Tester Program — Application Received";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${subject}</title>
</head>
<body style="margin:0; padding:0; background:#ffffff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif; color:#1a1a1a; line-height:1.5; -webkit-font-smoothing:antialiased;">

  <!-- Preheader: shown in the inbox list, hidden in the body. -->
  <div style="display:none; font-size:1px; color:#ffffff; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden;">We've received your application to the CRP Tester Program.</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
    <tr>
      <td align="center" style="padding:40px 16px;">

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; margin:0 auto;">

          <tr>
            <td align="center" style="padding-bottom:28px;">
              <img src="${LOGO_URL}" alt="CRP" width="72" height="72" style="display:block; margin:0 auto; border:0; outline:none; text-decoration:none;">
            </td>
          </tr>

          <tr>
            <td align="center" style="padding-bottom:8px;">
              <h1 style="margin:0; font-size:34px; line-height:1.15; font-weight:600; letter-spacing:-0.5px; color:#000000;">We're reviewing your application.</h1>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:20px 0 4px;">
              <p style="margin:0 0 18px; font-size:16px; color:#1a1a1a;">Hi ${greeting}</p>
              <p style="margin:0 0 18px; font-size:16px; color:#4a4a4a;">Thank you for applying to the CRP Tester Program.</p>
              <p style="margin:0; font-size:16px; color:#4a4a4a;">We've received your application and are currently reviewing your request. We'll notify you by email once there's an update.</p>
            </td>
          </tr>

          <tr>
            <td style="padding:32px 0;">
              <img src="${HERO_IMAGE_URL}" alt="CRP" width="600" style="display:block; width:100%; max-width:600px; height:auto; border:0; border-radius:20px; outline:none; text-decoration:none; background:#fcfcfc;">
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:8px 0 32px;">
              <p style="margin:0; font-size:16px; color:#4a4a4a;">Thank you for your interest in CRP.</p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding-bottom:36px;">
              <a href="${SITE_URL}" style="display:inline-block; padding:14px 34px; background:#000000; color:#ffffff; text-decoration:none; border-radius:40px; font-size:15px; font-weight:500;">Visit CRP</a>
            </td>
          </tr>

          <tr>
            <td align="center" style="border-top:1px solid #efefef; padding-top:24px;">
              <p style="margin:0 0 8px; font-size:13px; color:#8a8a8a;">&copy;2026 CRP. All rights reserved.</p>
              <p style="margin:0; font-size:13px; color:#8a8a8a;">
                You are receiving this because you applied to the CRP Tester Program.<br>
                <a href="${PRIVACY_URL}" style="color:#8a8a8a; text-decoration:underline;">Privacy policy</a>
              </p>
              <p style="margin:12px 0 0; font-size:12px; color:#b0b0b0; word-break:break-all;">Sent to ${safeEmail}</p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;

  // Plain-text alternative. Required: without it, clients that refuse HTML show
  // nothing at all, and spam filters read it to judge the message.
  const text = [
    "We're reviewing your application.",
    "",
    `Hi ${greetingFor(name)}`,
    "",
    "Thank you for applying to the CRP Tester Program.",
    "",
    "We've received your application and are currently reviewing your request. We'll notify you by email once there's an update.",
    "",
    "Thank you for your interest in CRP.",
    "",
    SITE_URL,
    "",
    "-",
    "(c)2026 CRP. All rights reserved.",
    "You are receiving this because you applied to the CRP Tester Program.",
    `Privacy policy: ${PRIVACY_URL}`,
  ].join("\n");

  return { subject, html, text };
}
