import assert from 'node:assert/strict';
import test from 'node:test';

const baseUrl = new URL(process.env.TEAMFLOW_SMOKE_BASE_URL).origin;
const mode = process.env.TEAMFLOW_SMOKE_MODE;

async function request(path, options) {
  return fetch(new URL(path, baseUrl), {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
}

function assertSecurityHeaders(response) {
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
}

function assertSingleMain(html) {
  assert.equal((html.match(/<main(?:\s|>)/gi) ?? []).length, 1);
}

function assertNamedServerRenderedControls(html) {
  const unnamedButtons = [];
  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const attributes = match[1];
    const text = match[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/<!--.*?-->/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const hasName =
      /\baria-label\s*=\s*["'][^"']+["']/i.test(attributes) ||
      /\baria-labelledby\s*=\s*["'][^"']+["']/i.test(attributes) ||
      text.length > 0;
    if (!hasName) unnamedButtons.push(match[0].slice(0, 120));
  }
  assert.deepEqual(unnamedButtons, []);
}

if (mode === 'development') {
  test('manager demo renders its accessible, synthetic-data shell', async () => {
    const response = await request('/');
    const html = await response.text();

    assert.equal(response.status, 200);
    assertSecurityHeaders(response);
    assert.match(html, /<html[^>]*lang="en"/i);
    assertSingleMain(html);
    assert.match(html, /Local demo:/);
    assert.match(html, /Do not use them for hiring decisions/);
    assert.match(html, /Search candidates/);
    assert.match(html, /Browse files/);
    assert.match(html, /Send invite by text/);
    assertNamedServerRenderedControls(html);
  });

  test('candidate demo renders a landmark and never starts in a completed state', async () => {
    const response = await request('/apply');
    const html = await response.text();

    assert.equal(response.status, 200);
    assertSecurityHeaders(response);
    assertSingleMain(html);
    assert.match(html, /Local demo — not a production authentication or hiring workflow/);
    assert.doesNotMatch(html, /Application received/);
    assertNamedServerRenderedControls(html);
  });
} else if (mode === 'production') {
  test('legacy demo pages remain unavailable in production', async () => {
    for (const path of ['/', '/apply']) {
      const response = await request(path);
      assert.equal(response.status, 404, path);
      assertSecurityHeaders(response);
    }
  });

  test('legacy demo mutations stop at the production route gate', async () => {
    for (const path of ['/api/application', '/api/invite']) {
      const response = await request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await response.json();
      assert.equal(response.status, 404, path);
      assert.deepEqual(body, { error: 'Not found' });
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  });
} else {
  throw new Error('TEAMFLOW_SMOKE_MODE must be development or production');
}
