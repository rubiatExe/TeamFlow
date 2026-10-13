import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredTokens = {
  '--cocoa-50': '#fdf6ec',
  '--cocoa-700': '#5c3318',
  '--cocoa-900': '#2c1a0f',
  '--cream-50': '#fffcf8',
  '--sage-600': '#4a7c4a',
};

/** @param {string} tag @param {string} name */
function attribute(tag, name) {
  return new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'iu')
    .exec(tag)?.[2]?.replaceAll('&amp;', '&') ?? '';
}

/** @param {string} html */
function stylesheetLinks(html) {
  return [...new Set([...html.matchAll(/<link\b[^>]*>/giu)]
    .filter(([tag]) => attribute(tag, 'rel').split(/\s+/u).includes('stylesheet'))
    .map(([tag]) => attribute(tag, 'href'))
    .filter(Boolean))];
}

/**
 * Check the compiled declarations consumed by this document, not source-file
 * strings or every file left in a build directory. Browser checks still cover
 * computed styles, responsive layout, and rendering.
 * @param {string} html
 * @param {string} css
 */
export function assertProductionStyles(html, css) {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .map(([, selector, content]) => ({
      selectors: selector.trim().split(',').map(value => value.trim()),
      declarations: new Map([...content.matchAll(/([\w-]+)\s*:\s*([^;]+)(?:;|$)/gu)]
        .map(([, property, value]) => [property, value.trim()])),
    }));
  /** @param {(rule: typeof rules[number]) => boolean} predicate */
  function declarationsFor(predicate) {
    return new Map(rules.filter(predicate).flatMap(rule => [...rule.declarations]));
  }

  const root = declarationsFor(rule => rule.selectors.includes(':root'));
  const body = declarationsFor(rule => rule.selectors.includes('body'));
  const sans = declarationsFor(rule => rule.selectors.includes('.font-sans'));
  const bodyClasses = attribute(html.match(/<body\b[^>]*>/iu)?.[0] ?? '', 'class').split(/\s+/u);
  const fonts = declarationsFor(rule => rule.selectors.some(selector => bodyClasses.includes(selector.slice(1)) && selector.startsWith('.')));
  const failures = [];

  for (const [name, expected] of Object.entries(requiredTokens)) {
    if (root.get(name)?.toLowerCase() !== expected) {
      failures.push(`${name} must be ${expected}; received ${root.get(name) ?? '(missing)'}`);
    }
  }
  if (!/^var\(--font-body\)(?:\s*,|$)/u.test(body.get('font-family') ?? '')) {
    failures.push('body font-family must use --font-body');
  }
  if (sans.get('font-family') !== 'var(--font-body)' || !bodyClasses.includes('font-sans')) {
    failures.push('the document must apply font-sans with font-family: var(--font-body)');
  }
  if (body.get('background') !== 'var(--cocoa-50)') {
    failures.push('body background must use --cocoa-50');
  }
  if (!/\bInter\b/u.test(fonts.get('--font-body') ?? '')) {
    failures.push('the document body must apply the generated Inter font variable');
  }
  if (!/Playfair Display/u.test(fonts.get('--font-display') ?? '')) {
    failures.push('the document body must apply the generated Playfair Display font variable');
  }
  if (/var\(--font-geist-sans\)/u.test(css)) {
    failures.push('the compiled stylesheet still references the retired Geist font variable');
  }
  if (failures.length) {
    throw new Error(`Production stylesheet mismatch:\n- ${failures.join('\n- ')}`);
  }
  return Object.keys(requiredTokens).length + 6;
}

/** @param {URL} url @param {string} expectedType */
async function fetchText(url, expectedType) {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.includes(expectedType)) {
    throw new Error(`${url.pathname}: expected ${expectedType}, received ${response.headers.get('content-type')}`);
  }
  return response.text();
}

/** @param {string} path */
async function optionalFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** @param {string} root @param {string} path */
function containedPath(root, path) {
  const file = resolve(root, path);
  const withinRoot = relative(root, file);
  if (isAbsolute(path) || withinRoot === '..' || withinRoot.startsWith(`..${sep}`)) {
    throw new Error(`Build artifact escapes its output directory: ${path}`);
  }
  return file;
}

/**
 * Vercel's Next adapter emits Build Output API v3 under <distDir>/output.
 * The deployment CLI can subsequently copy that output to .vercel/output.
 * App prerenders use functions/index.prerender-config.json's fallback; static
 * pages use the static root or a config.json override for the root pathname.
 * @param {string} outputRoot
 */
async function vercelBuildPage(outputRoot) {
  const configuration = await optionalFile(resolve(outputRoot, 'config.json'));
  if (configuration === null) return null;
  const config = JSON.parse(configuration);
  if (config.version !== 3) throw new Error(`Unsupported Vercel build output version in ${outputRoot}`);
  const staticRoot = resolve(outputRoot, 'static');
  const rootOverrides = Object.entries(config.overrides ?? {}).filter(([, override]) => (
    override && typeof override === 'object' && 'path' in override
    && ['', '/', '.', './'].includes(override.path)
  ));
  if (rootOverrides.length > 1) throw new Error(`Ambiguous root page overrides in ${outputRoot}`);
  const staticPage = rootOverrides.length
    ? containedPath(staticRoot, rootOverrides[0][0])
    : resolve(staticRoot, 'index.html');
  const staticHtml = await optionalFile(staticPage);
  if (staticHtml !== null) return { html: staticHtml, assetRoot: staticRoot, assetPrefix: '/', source: outputRoot };
  if (rootOverrides.length) throw new Error(`Missing configured root page: ${staticPage}`);

  const functionsRoot = resolve(outputRoot, 'functions');
  const prerenderConfig = await optionalFile(resolve(functionsRoot, 'index.prerender-config.json'));
  if (prerenderConfig !== null) {
    const { fallback } = JSON.parse(prerenderConfig);
    if (typeof fallback !== 'string' || !fallback.endsWith('.html')) {
      throw new Error(`The root prerender has no HTML fallback in ${outputRoot}`);
    }
    return {
      html: await readFile(containedPath(functionsRoot, fallback), 'utf8'),
      assetRoot: staticRoot, assetPrefix: '/', source: outputRoot,
    };
  }
  throw new Error(`No root HTML page or configured prerender fallback in ${outputRoot}`);
}

/** @param {string} buildRoot */
async function localBuildPage(buildRoot) {
  // Prefer the adapter's current deployable output when Next also leaves native
  // files behind. A present but broken adapter output must fail the check.
  const adapter = await vercelBuildPage(resolve(buildRoot, 'output'))
    ?? await vercelBuildPage(buildRoot);
  if (adapter) return adapter;
  const html = await optionalFile(resolve(buildRoot, 'server/app/index.html'));
  if (html !== null) return { html, assetRoot: buildRoot, assetPrefix: '/_next/', source: buildRoot };
  const deployment = await vercelBuildPage(resolve(dirname(buildRoot), '.vercel/output'));
  if (deployment) return deployment;
  throw new Error(`No native or Vercel root HTML output found for ${buildRoot}`);
}

/** @param {{ baseUrl?: string, buildDirectory?: string }} [options] */
export async function verifyProductionStyles({ baseUrl, buildDirectory } = {}) {
  const buildRoot = resolve(buildDirectory ?? resolve(repositoryRoot, '.next'));
  const pageUrl = new URL(baseUrl ?? 'http://build.invalid/');
  if (!['http:', 'https:'].includes(pageUrl.protocol)) {
    throw new Error('The stylesheet check requires an HTTP(S) URL');
  }
  const local = baseUrl ? null : await localBuildPage(buildRoot);
  const html = local ? local.html : await fetchText(pageUrl, 'text/html');
  const links = stylesheetLinks(html);
  const stylesheets = await Promise.all(links.map(async (href) => {
    const url = new URL(href, pageUrl);
    if (url.origin !== pageUrl.origin || !url.pathname.startsWith('/_next/static/')) {
      throw new Error(`Unexpected application stylesheet location: ${href}`);
    }
    return local
      ? readFile(containedPath(local.assetRoot, url.pathname.slice(local.assetPrefix.length)), 'utf8')
      : fetchText(url, 'text/css');
  }));
  const inlineStyles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)]
    .map(([, css]) => css);
  const checks = assertProductionStyles(html, [...stylesheets, ...inlineStyles].join('\n'));
  return { source: baseUrl ?? local?.source ?? buildRoot, stylesheets: links.length, checks };
}

async function main() {
  const options = {};
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith('--url=')) options.baseUrl = argument.slice('--url='.length);
    else if (argument.startsWith('--build-dir=')) options.buildDirectory = argument.slice('--build-dir='.length);
    else throw new Error('Usage: node scripts/verify-production-styles.mjs [--url=<URL> | --build-dir=<path>]');
  }
  const result = await verifyProductionStyles(options);
  console.log(`[styles] ${result.checks} compiled style checks passed for ${result.source} (${result.stylesheets} linked stylesheet(s))`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
