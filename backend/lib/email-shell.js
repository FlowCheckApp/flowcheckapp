/**
 * email-shell.js
 *
 * ONE layout for every email FlowCheck sends.
 *
 * WHY THIS EXISTS
 * ---------------
 * Thirty emails each hand-rolled their own HTML document, and they had
 * drifted into two visibly different products:
 *
 *   Welcome          560px · full <head> · logo · preheader · table layout
 *   Low Balance      480px · NO <head>   · none · none      · div layout
 *
 * Container widths ran to five values (480/520/540/560/…). Twenty-three of
 * the thirty had no preheader at all — that is the grey line beside the
 * subject in every inbox, and without it Gmail and Apple Mail scrape
 * whatever text appears first, which was frequently a logo alt or the
 * opening of a legal footer.
 *
 * WHAT EMAIL CLIENTS ACTUALLY NEED, and what the alert emails were missing:
 *
 *   · <meta charset>. Without it a subject or body containing an emoji or a
 *     curly quote can arrive as mojibake in Outlook and some Android
 *     clients. Most of these alerts open with an emoji.
 *   · <meta viewport>. Absent, iOS Mail renders at desktop width and the
 *     reader pinches to zoom.
 *   · TABLE layout. Outlook (2016/2019/365 desktop) renders through Word,
 *     which ignores max-width on a div, drops border-radius and does not
 *     support box-shadow. Several alerts leaned on all three.
 *   · A bulletproof button. A padded <a> collapses in Outlook; the padding
 *     has to live on a table cell.
 *
 * The layout is deliberately not configurable beyond tone and content.
 * Thirty emails that can each be a little different is exactly how this
 * ended up with five widths.
 */
'use strict';

/* Palette, in hex. Email clients have no CSS variables and no theming, so
   these are literal by necessity — this file is the one place they live. */
const TONE = {
  info:    { bar: '#1ac4f0', wash: '#eefaff', ink: '#0b3d52' },
  success: { bar: '#22a06b', wash: '#eefaf4', ink: '#0d3f2c' },
  warn:    { bar: '#ffb020', wash: '#fff8ec', ink: '#7a4b06' },
  danger:  { bar: '#e5484d', wash: '#fdeff0', ink: '#7a1d20' },
};

const PAGE_BG  = '#f3f4f6';
const CARD_BG  = '#ffffff';
const BODY_INK = '#374151';
const MUTED    = '#6b7280';
const FAINT    = '#9ca3af';
const WIDTH    = 560;
const FONT     = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/* For verification codes and aligned figures. font-variant-numeric is not
   reliable across email clients, so this reaches for real tabular faces
   instead — SF Mono on Apple, Consolas on Outlook, then generics. */
const FONT_MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * A button that survives Outlook. Padding on the <td>, never on the <a>.
 */
function button(label, href, tone = 'info') {
  const t = TONE[tone] || TONE.info;
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 4px">
    <tr><td align="center" bgcolor="${t.bar}" style="border-radius:10px">
      <a href="${esc(href)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px">${esc(label)}</a>
    </td></tr>
  </table>`;
}

/**
 * Wrap content in the shared shell.
 *
 * @param {object}  o
 * @param {string}  o.title      <title>, and the fallback subject line
 * @param {string}  o.preheader  REQUIRED — the inbox preview line
 * @param {string}  o.heading    the h1 in the header block
 * @param {string} [o.subheading]
 * @param {string}  o.bodyHtml   already-escaped HTML for the body
 * @param {string} [o.tone]      info | success | warn | danger
 * @param {string} [o.logoImg]   an <img> tag, or '' for none
 * @param {string} [o.footerHtml]
 */
function shell(o) {
  const {
    title, preheader, heading, subheading = '',
    bodyHtml, tone = 'info', logoImg = '', footerHtml = '',
  } = o || {};

  /* Preheader is required, not optional. Making it optional is how 23 of 30
     emails came to ship without one — every default that can be skipped
     eventually is. */
  if (!preheader) throw new Error('email shell: preheader is required');

  const t = TONE[tone] || TONE.info;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${PAGE_BG};font-family:${FONT};-webkit-font-smoothing:antialiased">

<!-- Preheader: the inbox preview line. The trailing entities stop clients
     pulling body copy in after it to fill the space. -->
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${PAGE_BG};opacity:0">${esc(preheader)}${'&#8203;&nbsp;'.repeat(60)}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAGE_BG};padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${WIDTH}px;width:100%">

  <tr><td style="background-color:${t.wash};border-top:4px solid ${t.bar};border-radius:14px 14px 0 0;padding:32px 36px;text-align:center">
    ${logoImg}
    <h1 style="color:${t.ink};font-size:24px;font-weight:800;margin:${logoImg ? '14px' : '0'} 0 0;letter-spacing:-0.02em;line-height:1.25">${esc(heading)}</h1>
    ${subheading ? `<p style="color:${MUTED};font-size:15px;margin:8px 0 0;line-height:1.5">${esc(subheading)}</p>` : ''}
  </td></tr>

  <tr><td style="background-color:${CARD_BG};padding:32px 36px;color:${BODY_INK};font-size:16px;line-height:1.65">
    ${bodyHtml}
  </td></tr>

  <tr><td style="background-color:${CARD_BG};border-radius:0 0 14px 14px;padding:0 36px 28px">
    <div style="border-top:1px solid #eef0f3;padding-top:18px;color:${FAINT};font-size:12px;line-height:1.6">
      ${footerHtml}
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

module.exports = { shell, button, TONE, esc, WIDTH, FONT, FONT_MONO };
