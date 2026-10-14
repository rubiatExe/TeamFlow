import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { NextRequest } from 'next/server.js';

import { createResumePreviewPost } from '../../app/api/application/resume-preview/handler.ts';
import { extractResumePrefill, ResumePrefillSchema } from '../../lib/domain/resume-prefill.ts';
import { getRoleById } from '../../lib/domain/roles.ts';

const barista = getRoleById('barista');
assert.ok(barista);

function enableLocalDemo(t: TestContext): void {
  const environment = process.env as Record<string, string | undefined>;
  const previousNodeEnv = environment.NODE_ENV;
  const previousFlag = environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES;
  environment.NODE_ENV = 'test';
  environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES = 'true';
  t.after(() => {
    if (previousNodeEnv === undefined) delete environment.NODE_ENV;
    else environment.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES;
    else environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES = previousFlag;
  });
}

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/application/resume-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validUpload = {
  fileData: Buffer.from('%PDF-synthetic').toString('base64'),
  mimeType: 'application/pdf',
  fileName: 'opaque-resume.pdf',
  roleId: 'barista',
};

test('prefills only stated applicant facts and maps them to editable form IDs', () => {
  const result = extractResumePrefill(`
# Alex Rivera
alex.rivera@example.com | (201) 555-0101
Location: Newark, NJ
Experience: 4 years
Skills: Espresso Machine, Customer Service, Latte Art, Inventory Management
Certifications: Food Handler's Permit, ServSafe Certified
Languages: English, Spanish
`, barista);

  assert.deepEqual(result, {
    fullName: 'Alex Rivera',
    email: 'alex.rivera@example.com',
    phone: '(201) 555-0101',
    city: 'Newark, NJ',
    yearsExperience: '3-5',
    skills: ['espresso_machine', 'customer_service', 'latte_art', 'inventory'],
    certifications: ['food_handler', 'servsafe'],
    languages: ['english', 'spanish'],
  });
  assert.deepEqual(ResumePrefillSchema.parse(result), result);
});

test('unknown and negative statements leave fields empty rather than fabricate answers', () => {
  const result = extractResumePrefill(`
# Professional Summary
No espresso machine experience.
Interested in culinary roles.
`, barista);
  assert.deepEqual(result, {
    fullName: '',
    email: '',
    phone: '',
    city: '',
    yearsExperience: '',
    skills: [],
    certifications: [],
    languages: [],
  });
  assert.equal(
    extractResumePrefill('Barista Resume\nbarista@example.com', barista).fullName,
    '',
  );
});

test('role skill matches stay within that role and location is never inferred', () => {
  const cashier = getRoleById('cashier');
  assert.ok(cashier);
  const result = extractResumePrefill(`
Jamie Morgan
jamie@example.com
Cash handling and latte art. Fluent in Spanish.
`, cashier);
  assert.equal(result.fullName, 'Jamie Morgan');
  assert.equal(result.city, '');
  assert.deepEqual(result.skills, ['cash_handling']);
  assert.deepEqual(result.languages, ['spanish']);
});

test('preview validates the request and returns extracted facts without a score', async t => {
  enableLocalDemo(t);
  let calls = 0;
  const handler = createResumePreviewPost({
    extract: async request => {
      calls += 1;
      assert.equal(request.mimeType, 'application/pdf');
      assert.equal(Buffer.from(request.bytes).toString(), '%PDF-synthetic');
      return { markdown: '# Alex Rivera\nalex@example.com' };
    },
  });
  const response = await handler(jsonRequest(validUpload));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(body.success, true);
  assert.equal(body.prefill.fullName, 'Alex Rivera');
  assert.equal(body.prefill.email, 'alex@example.com');
  assert.equal(body.prefill.score, undefined);
  assert.equal(calls, 1);

  const invalid = await handler(jsonRequest({ ...validUpload, roleId: 'unknown' }));
  assert.equal(invalid.status, 400);
  const malformed = await handler(jsonRequest({ ...validUpload, fileData: 'not-base64' }));
  assert.equal(malformed.status, 400);
  assert.equal(calls, 1);
});

test('preview route stops when local demo access is disabled', async t => {
  const environment = process.env as Record<string, string | undefined>;
  const previousFlag = environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES;
  environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES = 'false';
  t.after(() => {
    if (previousFlag === undefined) delete environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES;
    else environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES = previousFlag;
  });
  let called = false;
  const handler = createResumePreviewPost({
    extract: async () => { called = true; return { markdown: '' }; },
  });
  const response = await handler(jsonRequest(validUpload));
  assert.equal(response.status, 404);
  assert.equal(called, false);
});
