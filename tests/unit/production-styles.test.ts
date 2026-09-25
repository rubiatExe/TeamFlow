import assert from 'node:assert/strict';
import test from 'node:test';

import { assertProductionStyles } from '../../scripts/verify-production-styles.mjs';

const html = '<html><body class="inter-font playfair-font font-sans antialiased"></body></html>';
const currentCss = `
  .inter-font { --font-body: "Inter", "Inter Fallback"; }
  .playfair-font { --font-display: "Playfair Display", "Playfair Display Fallback"; }
  :root {
    --cocoa-50: #fdf6ec;
    --cocoa-700: #5c3318;
    --cocoa-900: #2c1a0f;
    --cream-50: #fffcf8;
    --sage-600: #4a7c4a;
  }
  @layer base {
    body { background: var(--cocoa-50); font-family: var(--font-body), Inter, sans-serif; }
  }
  @layer utilities { .font-sans { font-family: var(--font-body); } }
`;

test('production styles check accepts current compiled colors and matching font classes', () => {
  assert.equal(assertProductionStyles(html, currentCss), 11);
  assert.equal(assertProductionStyles(html, currentCss.replace(/\s+/gu, ' ')), 11);
});

test('production styles check rejects the deployed regression: new font assets with old global CSS', () => {
  const staleCss = `
    .inter-font { --font-body: "Inter", "Inter Fallback"; }
    .playfair-font { --font-display: "Playfair Display", "Playfair Display Fallback"; }
    :root { --stone-50: #fafaf9; --background: var(--stone-50); --lime-500: #84cc16; }
    body { background: var(--background); }
    .font-sans { font-family: var(--font-geist-sans), -apple-system, sans-serif; }
  `;
  assert.throws(() => assertProductionStyles(html, staleCss), /--cocoa-700[\s\S]*missing/u);
  assert.throws(() => assertProductionStyles(html, staleCss), /retired Geist/u);
});

test('production styles check requires token definitions, not class references or comments', () => {
  const missingToken = currentCss.replace('--cocoa-700: #5c3318;', '')
    + '/* :root { --cocoa-700: #5c3318; } */ .text-cocoa-700 { color: var(--cocoa-700); }';
  assert.throws(() => assertProductionStyles(html, missingToken), /--cocoa-700[\s\S]*missing/u);
});

test('production styles check rejects font declarations that the rendered body does not apply', () => {
  assert.throws(
    () => assertProductionStyles(html.replace('inter-font ', ''), currentCss),
    /body must apply the generated Inter/u,
  );
  assert.throws(
    () => assertProductionStyles(html, currentCss.replace('.font-sans { font-family: var(--font-body); }', '.font-sans { font-family: serif; }')),
    /font-sans with font-family/u,
  );
});

test('production styles check rejects a later root override of the current palette', () => {
  assert.throws(
    () => assertProductionStyles(html, `${currentCss}:root { --cocoa-700: #000; }`),
    /--cocoa-700 must be #5c3318; received #000/u,
  );
});
