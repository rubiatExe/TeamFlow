import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  guardLegacyDemoRoute,
  legacyDemoRoutesEnabled,
} from '../../lib/http/legacy-demo-route.ts';

test('legacy demo data routes require an exact local-only opt-in', () => {
  assert.equal(legacyDemoRoutesEnabled({ NODE_ENV: 'development' }), false);
  assert.equal(legacyDemoRoutesEnabled({
    TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES: 'true',
  }), false);
  assert.equal(legacyDemoRoutesEnabled({
    NODE_ENV: 'staging',
    TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES: 'true',
  }), false);
  assert.equal(legacyDemoRoutesEnabled({
    NODE_ENV: 'development',
    TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES: 'TRUE',
  }), false);
  assert.equal(legacyDemoRoutesEnabled({
    NODE_ENV: 'development',
    TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES: 'true',
  }), true);
  assert.equal(legacyDemoRoutesEnabled({
    NODE_ENV: 'test',
    TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES: 'true',
  }), true);
});

test('production cannot enable unauthenticated legacy demo routes', async () => {
  const response = guardLegacyDemoRoute({
    NODE_ENV: 'production',
    TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES: 'true',
  });

  assert.ok(response);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), { error: 'Not found' });
});

test('all unauthenticated legacy route handlers guard before input or side effects', () => {
  const routes = new Map([
    ['app/api/candidates/route.ts', 2],
    ['app/api/invite/handler.ts', 1],
    ['app/api/parser/route.ts', 1],
    ['app/api/application/handler.ts', 1],
    ['app/api/square/labor/route.ts', 1],
  ]);

  for (const [path, expectedGuards] of routes) {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    assert.equal(
      source.match(/guardLegacyDemoRoute\(\)/g)?.length,
      expectedGuards,
      path,
    );
    const guardIndex = source.indexOf('guardLegacyDemoRoute()');
    const requestReadIndexes = [
      source.indexOf('req.json()'),
      source.indexOf('readBoundedJson(req'),
      source.indexOf('new URL(req.url)'),
    ].filter(index => index >= 0);
    assert.ok(requestReadIndexes.every(index => guardIndex < index), path);
  }
});

test('invite and SMS logging never includes the bearer URL or recipient PII', () => {
  const inviteSource = readFileSync(
    new URL('../../app/api/invite/handler.ts', import.meta.url),
    'utf8',
  );
  const smsSource = readFileSync(
    new URL('../../lib/integrations/twilio.ts', import.meta.url),
    'utf8',
  );

  assert.equal(inviteSource.includes('Generated magic link'), false);
  assert.equal(inviteSource.includes('console.log(`'), false);
  assert.equal(smsSource.includes('console.log(`   To:'), false);
  assert.equal(smsSource.includes('console.log(`   Message:'), false);
  assert.equal(smsSource.includes("console.error('Twilio error:', error)"), false);
  assert.equal(smsSource.includes("console.error('SMS sending failed:', error)"), false);
});
