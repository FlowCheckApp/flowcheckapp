#!/usr/bin/env node
/**
 * test-email-shell.js
 *
 * Pins the things email clients actually punish, each of which some
 * FlowCheck email was already getting wrong before the shell existed:
 *
 *   · a missing <meta charset> turns an emoji subject into mojibake in
 *     Outlook — and most of the alert emails open with one;
 *   · a missing preheader lets Gmail scrape whatever text comes first,
 *     which was often a logo alt or the opening of the legal footer;
 *   · a padded <a> collapses to unclickable text in Outlook, so button
 *     padding has to sit on a <td>;
 *   · div-based layout with max-width is ignored by Outlook's Word
 *     renderer, so the frame has to be tables.
 */
'use strict';

const { shell, button, esc, WIDTH } = require('../backend/lib/email-shell');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (err) { failed++; console.log('  ✗ ' + name + '\n    ' + err.message); }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, m) { if (a !== b) throw new Error((m || '') + ` expected ${b}, got ${a}`); }

const base = {
  title: 'Low Balance',
  preheader: 'Chase Checking is down to $42.10.',
  heading: 'Low balance',
  bodyHtml: '<p>Body copy.</p>',
  tone: 'warn',
  footerHtml: 'FlowCheck',
};

t('renders a complete document', () => {
  const html = shell(base);
  ok(html.startsWith('<!DOCTYPE html>'), 'must start with a doctype');
  ok(/<html lang="en"/.test(html), 'needs a lang for screen readers');
  ok(html.trim().endsWith('</html>'));
});

t('declares charset — emoji subjects depend on it', () => {
  ok(/<meta charset="utf-8">/.test(shell(base)));
});

t('declares viewport — otherwise iOS Mail renders at desktop width', () => {
  ok(/name="viewport"/.test(shell(base)));
});

t('preheader is REQUIRED, not optional', () => {
  let threw = false;
  try { shell({ ...base, preheader: '' }); } catch (_) { threw = true; }
  ok(threw, 'an email without a preheader must not build');
});

t('preheader text is present and hidden', () => {
  const html = shell(base);
  ok(html.includes('Chase Checking is down to $42.10.'));
  const seg = html.slice(html.indexOf('Chase Checking') - 220, html.indexOf('Chase Checking'));
  ok(/display:none/.test(seg), 'preheader must be visually hidden');
  ok(/max-height:0/.test(seg));
});

t('preheader is padded so body copy is not pulled in after it', () => {
  ok(shell(base).includes('&#8203;&nbsp;'.repeat(10)));
});

t('frame is tables, not divs — Outlook ignores max-width on a div', () => {
  const html = shell(base);
  ok(/<table role="presentation"/.test(html));
  const frame = html.slice(html.indexOf('<body'), html.indexOf(base.bodyHtml));
  ok(!/<div[^>]*max-width/.test(frame), 'no max-width div in the frame');
});

t('one canonical width', () => {
  eq(WIDTH, 560);
  const widths = [...shell(base).matchAll(/max-width:(\d+)px/g)].map(m => m[1]);
  eq([...new Set(widths)].length, 1, 'exactly one container width:');
});

t('escapes heading, preheader and title', () => {
  const html = shell({ ...base, heading: '<script>x</script>', preheader: 'a & b', title: '"q"' });
  ok(!html.includes('<script>x</script>'), 'heading must be escaped');
  ok(html.includes('a &amp; b'));
});

t('body html is NOT escaped — callers pass markup', () => {
  ok(shell({ ...base, bodyHtml: '<strong>hi</strong>' }).includes('<strong>hi</strong>'));
});

t('every tone renders and differs', () => {
  const seen = new Set();
  for (const tone of ['info', 'success', 'warn', 'danger']) {
    const html = shell({ ...base, tone });
    const m = html.match(/border-top:4px solid (#[0-9a-f]{6})/i);
    ok(m, tone + ' must set a header bar colour');
    seen.add(m[1]);
  }
  eq(seen.size, 4, 'four distinct tone colours:');
});

t('unknown tone falls back rather than rendering undefined', () => {
  const html = shell({ ...base, tone: 'nonsense' });
  ok(!/undefined/.test(html), 'no undefined in output');
});

t('button padding is on the td, not the a — Outlook collapses the a', () => {
  const b = button('View Accounts', 'https://example.com', 'info');
  ok(/<td[^>]*bgcolor="#1ac4f0"/.test(b), 'td carries the fill');
  ok(/<a [^>]*padding:14px 28px/.test(b), 'anchor carries display:inline-block padding');
  ok(/<table role="presentation"/.test(b), 'button is a table');
});

t('button escapes its href and label', () => {
  const b = button('a"b', 'https://x.test/?a=1&b=2');
  ok(b.includes('&amp;b=2'));
  ok(!b.includes('a"b'));
});

t('subheading is optional and omitted cleanly', () => {
  ok(!/margin:8px 0 0/.test(shell(base)), 'no empty subheading paragraph');
  ok(/margin:8px 0 0/.test(shell({ ...base, subheading: 'Sub' })));
});

t('no unsupported CSS in the frame', () => {
  const html = shell(base);
  const frame = html.slice(0, html.indexOf(base.bodyHtml));
  ok(!/box-shadow/.test(frame), 'box-shadow is ignored by Outlook');
  ok(!/flex|grid/.test(frame), 'no flex/grid in email');
});

t('esc handles the characters that break email', () => {
  eq(esc('<a>&"\''), '&lt;a&gt;&amp;&quot;&#39;');
  eq(esc(null), '');
  eq(esc(undefined), '');
});

console.log(`email-shell: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log('✓ one shell, and no email can ship without a preheader.');
