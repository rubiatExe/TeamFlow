import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../../supabase/migrations/20261013134851_google_cloud_vision_extraction_method.sql', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8');

test('Vision migration widens only the extraction-method constraint and preserves old records', () => {
  const statement = "check (extraction_method in ('pdf_text', 'gemini_vision', 'google_cloud_vision'))";
  assert.ok(migration.includes(statement));
  assert.ok(schema.includes(statement));
  assert.match(migration, /begin;/u);
  assert.match(migration, /commit;/u);
  assert.match(migration, /alter table public\.resume_documents\s+drop constraint resume_documents_extraction_method_check,\s+add constraint resume_documents_extraction_method_check/u);
  const sql = migration.replace(/--[^\n]*/gu, '');
  assert.doesNotMatch(sql, /\b(?:grant|revoke|update|delete|insert|truncate|disable|policy|function)\b/iu);
  assert.equal((sql.match(/alter table/gu) ?? []).length, 1);
});
