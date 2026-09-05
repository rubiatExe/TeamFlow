import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import nextConfig from '../../next.config.ts';
import {
  generateMagicToken,
  verifyMagicToken,
} from '../../lib/integrations/magic-link.ts';
import {
  resolveTrustedServiceBaseUrl,
  ServiceUrlConfigurationError,
} from '../../lib/http/trusted-service-url.ts';
import { isValidServiceToken } from '../../lib/http/service-token.ts';
import { requestDocumentExtraction } from '../../lib/ai/document-processor-client.ts';

test('global Next configuration keeps internal service URLs server-only', async () => {
  assert.equal(nextConfig.env, undefined);
  assert.equal(nextConfig.poweredByHeader, false);
  assert.ok(nextConfig.headers);

  const rules = await nextConfig.headers();
  assert.equal(rules.length, 1);
  const headers = new Map(
    rules[0].headers.map(header => [header.key.toLowerCase(), header.value]),
  );
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.match(headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/u);
  assert.match(headers.get('permissions-policy') ?? '', /camera=\(\)/u);
});

test('credential-bearing service URLs require exact HTTPS trust in production', () => {
  const production = { NODE_ENV: 'production' };

  assert.equal(
    resolveTrustedServiceBaseUrl(
      'https://processor.example.test/',
      'https://processor.example.test',
      production,
    ),
    'https://processor.example.test',
  );
  for (const [url, trusted] of [
    ['http://processor.example.test', 'http://processor.example.test'],
    ['https://processor.example.test', undefined],
    ['https://processor.example.test/path', 'https://processor.example.test'],
    ['https://user:pass@processor.example.test', 'https://processor.example.test'],
    ['https://processor.example.test?redirect=evil', 'https://processor.example.test'],
    ['https://evil.example.test', 'https://processor.example.test'],
  ] as const) {
    assert.throws(
      () => resolveTrustedServiceBaseUrl(url, trusted, production),
      ServiceUrlConfigurationError,
    );
  }
});

test('development service URLs are limited to loopback or reserved test hosts', () => {
  assert.equal(
    resolveTrustedServiceBaseUrl('http://localhost:8000', undefined, {}),
    'http://localhost:8000',
  );
  assert.equal(
    resolveTrustedServiceBaseUrl('http://hiring-agent.test', undefined, {}),
    'http://hiring-agent.test',
  );
  assert.throws(
    () => resolveTrustedServiceBaseUrl('https://attacker.example', undefined, {}),
    ServiceUrlConfigurationError,
  );
});

test('public service credentials require production-strength printable secrets', () => {
  assert.equal(isValidServiceToken('local-token', { NODE_ENV: 'test' }), true);
  assert.equal(isValidServiceToken('short', { NODE_ENV: 'production' }), false);
  assert.equal(
    isValidServiceToken('0123456789abcdef0123456789abcdef', {
      NODE_ENV: 'production',
    }),
    true,
  );
  assert.equal(
    isValidServiceToken('0123456789abcdef0123456789abcde\n', {
      NODE_ENV: 'production',
    }),
    false,
  );
});

test('origin or token mismatch fails before a credential-bearing fetch', async t => {
  const environment = process.env as Record<string, string | undefined>;
  const previousNodeEnv = process.env.NODE_ENV;
  environment.NODE_ENV = 'production';
  t.after(() => {
    if (previousNodeEnv === undefined) delete environment.NODE_ENV;
    else environment.NODE_ENV = previousNodeEnv;
  });
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run');
  };
  const baseRequest = {
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    mimeType: 'application/pdf',
    fileName: 'candidate.pdf',
    trustedOrigin: 'https://processor.example.test',
    fetchImpl,
  };

  await assert.rejects(
    requestDocumentExtraction({
      ...baseRequest,
      serviceUrl: 'https://attacker.example.test',
      token: '0'.repeat(32),
    }),
    /document_processor_not_configured/u,
  );
  await assert.rejects(
    requestDocumentExtraction({
      ...baseRequest,
      serviceUrl: 'https://processor.example.test',
      token: 'weak',
    }),
    /document_processor_not_configured/u,
  );
  assert.equal(fetchCalls, 0);
});

test('magic links remain an explicit local demo and have no production fallback secret', t => {
  const environment = process.env as Record<string, string | undefined>;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFlag = process.env.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES;
  const previousSecret = process.env.JWT_SECRET;
  t.after(() => {
    if (previousNodeEnv === undefined) delete environment.NODE_ENV;
    else environment.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES;
    else environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES = previousFlag;
    if (previousSecret === undefined) delete environment.JWT_SECRET;
    else environment.JWT_SECRET = previousSecret;
  });

  environment.NODE_ENV = 'production';
  environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES = 'true';
  delete environment.JWT_SECRET;
  assert.throws(
    () => generateMagicToken({
      candidateId: 'private-candidate',
      candidateName: 'Private Candidate',
    }),
    /not configured/u,
  );
  assert.equal(verifyMagicToken('not-a-token'), null);

  environment.NODE_ENV = 'test';
  const token = generateMagicToken({
    candidateId: 'demo-candidate',
    candidateName: 'Demo Candidate',
  });
  assert.equal(verifyMagicToken(token)?.candidateId, 'demo-candidate');
});

test('manager and candidate portals are excluded from the production artifact', () => {
  const managerPage = readFileSync('app/page.tsx', 'utf8');
  const candidatePage = readFileSync('app/apply/page.tsx', 'utf8');

  for (const source of [managerPage, candidatePage]) {
    assert.match(source, /legacyDemoRoutesEnabled\(\)/u);
    assert.match(source, /notFound\(\)/u);
  }
});
