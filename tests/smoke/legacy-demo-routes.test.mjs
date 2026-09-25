import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyProductionStyles } from '../../scripts/verify-production-styles.mjs';

const baseUrl = new URL(process.env.TEAMFLOW_SMOKE_BASE_URL).origin;
const mode = process.env.TEAMFLOW_SMOKE_MODE;

async function request(path, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(new URL(path, baseUrl), {
      ...options,
      redirect: 'manual',
      signal: controller.signal,
    });
    const body = await response.arrayBuffer();
    const bodylessStatus = [101, 204, 205, 304].includes(response.status);
    return new Response(bodylessStatus ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
  }
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
  test('public Cocoa dashboard renders its accessible hiring workspace', async () => {
    const response = await request('/');
    const html = await response.text();

    assert.equal(response.status, 200);
    assertSecurityHeaders(response);
    assert.match(html, /<html[^>]*lang="en"/i);
    assertSingleMain(html);
    assert.match(html, /Cocoa Bakery/);
    assert.match(html, /Hiring for Barista/);
    assert.match(html, /Candidate hiring pipeline/);
    assert.match(html, /Upload Resumes/);
    assert.match(html, /Smart Search/);
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
  test('production serves the current Cocoa theme and its matching font variables', async () => {
    await verifyProductionStyles({ baseUrl });
  });

  test('public search respects the visible sample candidate scope and cites its evidence', async () => {
    const response = await request('/api/demo/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({
        query: 'Weekend barista who knows latte art',
        roleId: 'barista',
        candidateRefs: ['SYN-CAND-002'],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.result_count, 1);
    assert.equal(payload.results[0].synthetic_candidate_ref, 'SYN-CAND-002');
    assert.equal(payload.results[0].display_name, 'Leo M.');
    assert.ok(payload.results[0].citations.some(citation => /latte art/iu.test(citation.exact_quote)));
    assert.ok(payload.results[0].citations.some(citation => /Saturday/iu.test(citation.exact_quote)));
    assert.equal(payload.decision_status, 'no_hiring_decision');
    assert.ok(['live_embedding', 'deterministic_fallback'].includes(payload.retrieval.mode));
  });

  test('public bakery-owner workspace is available while the legacy candidate page remains closed', async () => {
    const publicResponse = await request('/');
    const html = await publicResponse.text();
    assert.equal(publicResponse.status, 200);
    assertSecurityHeaders(publicResponse);
    assertSingleMain(html);
    assert.match(html, /Cocoa Bakery/);
    assert.match(html, /Hiring for Barista/);
    assert.match(html, /Candidate hiring pipeline/);
    assert.match(html, /Upload Resumes/);
    assert.match(html, /Smart Search/);

    const candidateResponse = await request('/apply');
    assert.equal(candidateResponse.status, 404);
    assertSecurityHeaders(candidateResponse);
  });

  test('legacy demo data routes stop at the production route gate', async () => {
    for (const [path, method] of [
      ['/api/application', 'POST'],
      ['/api/invite', 'POST'],
      ['/api/parser', 'POST'],
      ['/api/candidates', 'GET'],
      ['/api/candidates?id=demo_1', 'DELETE'],
      ['/api/square/labor', 'GET'],
    ]) {
      const response = await request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
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
