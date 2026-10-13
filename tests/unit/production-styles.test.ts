import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { assertProductionStyles, verifyProductionStyles } from '../../scripts/verify-production-styles.mjs';

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

const linkedHtml = html.replace('<html>', '<html><head><link rel="stylesheet" href="/_next/static/immutable/chunks/theme.css?dpl=fixture"></head>');

async function buildFixture(context: TestContext, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'teamflow-style-output-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

test('native Next output verifies only the stylesheets linked by its homepage', async context => {
  const root = await buildFixture(context, {
    '.next/server/app/index.html': linkedHtml,
    '.next/static/immutable/chunks/theme.css': currentCss,
    '.next/static/unlinked-old-theme.css': ':root { --cocoa-700: #000; }',
  });
  assert.deepEqual(await verifyProductionStyles({ buildDirectory: join(root, '.next') }), {
    source: join(root, '.next'), stylesheets: 1, checks: 11,
  });
});

test('Next Vercel adapter verifies the manifest-linked app prerender and packaged CSS', async context => {
  const root = await buildFixture(context, {
    '.next/output/config.json': JSON.stringify({ version: 3 }),
    '.next/output/functions/index.prerender-config.json': JSON.stringify({ fallback: 'home.prerender-fallback.html' }),
    '.next/output/functions/home.prerender-fallback.html': linkedHtml,
    '.next/output/static/_next/static/immutable/chunks/theme.css': currentCss,
  });
  assert.deepEqual(await verifyProductionStyles({ buildDirectory: join(root, '.next') }), {
    source: join(root, '.next/output'), stylesheets: 1, checks: 11,
  });
});

test('Vercel static root overrides and final deployment output retain all style checks', async context => {
  const root = await buildFixture(context, {
    '.vercel/output/config.json': JSON.stringify({ version: 3, overrides: { '.html': { path: '.' } } }),
    '.vercel/output/static/.html': linkedHtml,
    '.vercel/output/static/_next/static/immutable/chunks/theme.css': currentCss,
  });
  const direct = await verifyProductionStyles({ buildDirectory: join(root, '.vercel/output') });
  assert.equal(direct.checks, 11);
  assert.equal(direct.stylesheets, 1);
  const discovered = await verifyProductionStyles({ buildDirectory: join(root, '.next') });
  assert.deepEqual(discovered, direct);
});

test('adapter output cannot pass by borrowing valid native HTML or CSS', async context => {
  const root = await buildFixture(context, {
    '.next/server/app/index.html': linkedHtml,
    '.next/static/immutable/chunks/theme.css': currentCss,
    '.next/output/config.json': JSON.stringify({ version: 3 }),
    '.next/output/static/index.html': linkedHtml,
    '.next/output/static/_next/static/immutable/chunks/theme.css': currentCss.replace('--cocoa-700: #5c3318;', '--cocoa-700: #000;'),
  });
  await assert.rejects(verifyProductionStyles({ buildDirectory: join(root, '.next') }), /--cocoa-700 must be/u);
  await rm(join(root, '.next/output/static/_next/static/immutable/chunks/theme.css'));
  await assert.rejects(verifyProductionStyles({ buildDirectory: join(root, '.next') }), /ENOENT/u);
});

test('broken or escaping prerender manifests fail without skipping verification', async context => {
  const root = await buildFixture(context, {
    '.next/output/config.json': JSON.stringify({ version: 3 }),
    '.next/output/functions/index.prerender-config.json': JSON.stringify({ fallback: '../../outside.html' }),
  });
  await assert.rejects(verifyProductionStyles({ buildDirectory: join(root, '.next') }), /escapes its output directory/u);
  await writeFile(join(root, '.next/output/functions/index.prerender-config.json'), JSON.stringify({ fallback: null }));
  await assert.rejects(verifyProductionStyles({ buildDirectory: join(root, '.next') }), /no HTML fallback/u);
});
