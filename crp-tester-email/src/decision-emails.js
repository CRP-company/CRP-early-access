/**
 * Decision emails: acceptance and rejection.
 *
 * These share the layout, escaping and plain-text fallback of
 * `buildApplicationReceivedEmail()` in email-template.js, so all three CRP
 * Tester Program emails read as one set. Email clients are a hostile rendering
 * environment, so everything is table-based with inline CSS: no flexbox, no
 * grid, no external stylesheet, no web fonts.
 *
 * The acceptance email carries the tester's number and a "Save to Google
 * Wallet" button. That URL is a signed, single-tester JWT produced by the
 * Wallet issuer; it grants access only to that one pass and is safe to email.
 * No service-account credential, private key or Firebase token is ever
 * included — only the URL and the number.
 */

import { escapeHtml, greetingFor } from "./email-template.js";

const DEFAULTS = {
  logoUrl: "https://i.postimg.cc/K8zf4q4q/CRPlogo.png",
  siteUrl: "https://crp-company.github.io/CRP-early-access/",
  privacyUrl: "https://crp-company.github.io/CRP-Privacy-policy/",
};

/** Shared shell so all three emails stay visually identical. */
function shell({ subject, preheader, bodyRows, email }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${subject}</title>
</head>
<body style="margin:0; padding:0; background:#ffffff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif; color:#1a1a1a; line-height:1.5; -webkit-font-smoothing:antialiased;">

  <!-- Preheader: shown in the inbox list, hidden in the body. -->
  <div style="display:none; font-size:1px; color:#ffffff; line-height:1px; max-height:0; max-width:0; overflow:hidden;">${preheader}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; margin:0 auto;">

          <tr>
            <td align="center" style="padding-bottom:28px;">
              <img src="${DEFAULTS.logoUrl}" alt="CRP" width="72" height="72" style="display:block; margin:0 auto; border:0; outline:none; text-decoration:none;">
            </td>
          </tr>

          ${bodyRows}

          <tr>
            <td align="center" style="padding-bottom:36px;">
              <a href="${DEFAULTS.siteUrl}" style="display:inline-block; padding:14px 34px; background:#000000; color:#ffffff; text-decoration:none; border-radius:40px; font-size:15px; font-weight:500;">Visit CRP</a>
            </td>
          </tr>

          <tr>
            <td align="center" style="border-top:1px solid #efefef; padding-top:24px;">
              <p style="margin:0 0 8px; font-size:13px; color:#8a8a8a;">&copy;2026 CRP. All rights reserved.</p>
              <p style="margin:0; font-size:13px; color:#8a8a8a;">
                You are receiving this because you applied to the CRP Tester Program.<br>
                <a href="${DEFAULTS.privacyUrl}" style="color:#8a8a8a; text-decoration:underline;">Privacy policy</a>
              </p>
              <p style="margin:12px 0 0; font-size:12px; color:#b0b0b0; word-break:break-all;">Sent to ${escapeHtml(email)}</p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}

/** Shared footer for the plain-text part. */
function footerText() {
  return [
    "",
    "-",
    "(c)2026 CRP. All rights reserved.",
    "You are receiving this because you applied to the CRP Tester Program.",
    `Privacy policy: ${DEFAULTS.privacyUrl}`,
    DEFAULTS.siteUrl,
  ];
}

/**
 * Build the acceptance email.
 *
 * @param {object} data
 * @param {string} data.name
 * @param {string} data.email
 * @param {number} data.testerNumber  Sequential tester number.
 * @param {string} data.saveUrl      Google Wallet "Save to Google Wallet" URL.
 * @returns {{subject: string, html: string, text: string}}
 */
export function buildAcceptanceEmail({ name, email, testerNumber, saveUrl }) {
  const greeting = escapeHtml(greetingFor(name));
  // The number is server-allocated and numeric; the save URL is produced by our
  // own Wallet issuer, never by a visitor. Both are escaped anyway, so a
  // malformed value can never break out of an attribute or inject markup.
  const number = escapeHtml(String(testerNumber));
  const url = escapeHtml(saveUrl);
  const subject = "You're in — CRP Testing Program";

  const bodyRows = `
          <tr>
            <td align="center" style="padding-bottom:8px;">
              <h1 style="margin:0; font-size:34px; line-height:1.15; font-weight:600; letter-spacing:-0.5px; color:#000000;">
                You're in.
              </h1>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:20px 0 4px;">
              <p style="margin:0 0 18px; font-size:16px; color:#1a1a1a;">Hi ${greeting}</p>
              <p style="margin:0 0 18px; font-size:16px; color:#4a4a4a;">You're officially part of the CRP Testing Program.</p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:4px 0 24px;">
              <img
                src="https://crp-company.github.io/CRP-early-access/assets/CRPtesterCARD-trim.png"
                alt="CRP Tester Card"
                width="260"
                style="display:block; width:260px; max-width:100%; height:auto; margin:0 auto; border:0; outline:none; text-decoration:none;"
              >
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:8px 0 4px;">
              <p style="margin:0; font-size:13px; letter-spacing:2px; color:#8a8a8a;">TESTER #${number}</p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:28px 0 8px;">
              <a href="${url}" style="display:inline-block; padding:16px 40px; background:#000000; color:#ffffff; text-decoration:none; border-radius:40px; font-size:15px; font-weight:600; letter-spacing:0.3px;">ADD TO GOOGLE WALLET</a>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:12px 0 28px;">
              <p style="margin:0 0 10px; font-size:16px; color:#4a4a4a;">Your CRP Testing Card is your identification for the program. Show it whenever you sign in to a CRP session.</p>
              <p style="margin:0; font-size:16px; color:#4a4a4a;">The card may be updated during the program, so keep it in your wallet rather than as a screenshot.</p>
            </td>
          </tr>`;


  const text = [
    "You're in.",
    "",
    `Hi ${greetingFor(name)}`,
    "",
    "You're officially part of the CRP Testing Program.",
    "",
    `TESTER #${testerNumber}`,
    "",
    "ADD TO GOOGLE WALLET:",
    saveUrl,
    "",
    "Your CRP Testing Card is your identification for the program. Show it whenever you sign in to a CRP session.",
    "",
    "The card may be updated during the program, so keep it in your wallet rather than as a screenshot.",
    ...footerText(),
  ].join("\n");

  return {
    subject,
    html: shell({
      subject,
      preheader: `You're in — CRP Testing Program. Your tester number is #${testerNumber}.`,
      bodyRows,
      email,
    }),
    text,
  };
}

/**
 * Build the rejection email.
 *
 * Deliberately carries no Wallet link: a rejected applicant has no pass, so a
 * link would point at a card that must not exist.
 *
 * @param {object} data
 * @param {string} data.name
 * @param {string} data.email
 * @returns {{subject: string, html: string, text: string}}
 */
export function buildRejectionEmail({ name, email }) {
  const greeting = escapeHtml(greetingFor(name));
  const subject = "CRP Testing Program — Application Update";

  const bodyRows = `
          <tr>
            <td align="center" style="padding-bottom:8px;">
              <h1 style="margin:0; font-size:30px; line-height:1.2; font-weight:600; letter-spacing:-0.5px; color:#000000;">Application update</h1>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:20px 0 4px;">
              <p style="margin:0 0 18px; font-size:16px; color:#1a1a1a;">Hi ${greeting}</p>
              <p style="margin:0 0 18px; font-size:16px; color:#4a4a4a;">Thank you for applying to the CRP Tester Program.</p>
              <p style="margin:0; font-size:16px; color:#4a4a4a;">After reviewing your application, we weren't able to accept it at this time. We know that's disappointing, and we appreciate you taking the time to apply.</p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:28px 0 24px;">
              <p style="margin:0; font-size:16px; color:#4a4a4a;">If CRP opens more places in future, we'd love to hear from you again.</p>
            </td>
          </tr>`;

  const text = [
    "Application update",
    "",
    `Hi ${greetingFor(name)}`,
    "",
    "Thank you for applying to the CRP Tester Program.",
    "",
    "After reviewing your application, we weren't able to accept it at this time. We know that's disappointing, and we appreciate you taking the time to apply.",
    "",
    "If CRP opens more places in future, we'd love to hear from you again.",
    ...footerText(),
  ].join("\n");

  return {
    subject,
    html: shell({
      subject,
      preheader: "CRP Testing Program — an update on your application.",
      bodyRows,
      email,
    }),
    text,
  };
}
