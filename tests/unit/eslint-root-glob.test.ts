import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { getRootDirs } = require("@next/eslint-plugin-next/dist/utils/get-root-dirs.js") as {
  getRootDirs(context: { cwd: string; settings: { next?: { rootDir?: unknown } } }): string[];
};
const pluginRequire = createRequire(require.resolve("@next/eslint-plugin-next"));
const { globSync } = pluginRequire("fast-glob") as {
  globSync(pattern: unknown, options: Record<string, unknown>): string[];
};

test("the installed Next.js plugin retains directory root discovery with the audit-safe adapter", (t) => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "teamflow-eslint-roots-")));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, "apps/web/nested"), { recursive: true });
  mkdirSync(join(fixture, "apps/api"), { recursive: true });
  writeFileSync(join(fixture, "apps/README.md"), "not a directory");
  const absoluteApps = join(fixture, "apps");
  const relativeApps = relative(process.cwd(), absoluteApps);

  // Expected paths follow the original fast-glob call: static spelling is
  // retained; wildcard matches omit trailing slashes and exclude files.
  const cases: [string, string[]][] = [
    [`${relativeApps}/web`, [`${relativeApps}/web`]],
    [`${relativeApps}/web/`, [`${relativeApps}/web/`]],
    [`./${relativeApps}/web`, [`./${relativeApps}/web`]],
    [`${absoluteApps}/web`, [`${absoluteApps}/web`]],
    [`${absoluteApps}/web/`, [`${absoluteApps}/web/`]],
    [`${relativeApps}/*`, [`${relativeApps}/api`, `${relativeApps}/web`]],
    [`${relativeApps}/*/`, [`${relativeApps}/api`, `${relativeApps}/web`]],
    [`./${relativeApps}/*`, [`./${relativeApps}/api`, `./${relativeApps}/web`]],
    [`${absoluteApps}/*`, [`${absoluteApps}/api`, `${absoluteApps}/web`]],
    [`${absoluteApps}/*/`, [`${absoluteApps}/api`, `${absoluteApps}/web`]],
    [`${relativeApps}/{web,api}`, [`${relativeApps}/api`, `${relativeApps}/web`]],
    [`${absoluteApps}/missing`, []],
    [`${relativeApps}/missing*`, []],
    [`${relativeApps}/README.md`, []],
  ];
  for (const [rootDir, expected] of cases) {
    assert.deepEqual(
      getRootDirs({ cwd: process.cwd(), settings: { next: { rootDir } } }).sort(),
      expected.sort(),
      rootDir,
    );
  }
  assert.deepEqual(getRootDirs({ cwd: fixture, settings: {} }), [fixture]);
  assert.deepEqual(
    getRootDirs({
      cwd: process.cwd(),
      settings: { next: { rootDir: [`${absoluteApps}/web`, `${absoluteApps}/api`] } },
    }),
    [`${absoluteApps}/web`, `${absoluteApps}/api`],
  );

});

test("the lint adapter rejects changed API usage and unsupported brace ranges", () => {
  assert.throws(() => globSync("app", {}), TypeError);
  assert.throws(() => globSync(["app"], { onlyDirectories: true }), TypeError);
  assert.throws(() => globSync("app", { onlyDirectories: true, deep: 1 }), TypeError);
  assert.throws(() => globSync("app-{01..03}", { onlyDirectories: true }), TypeError);
  assert.throws(() => globSync("app-{1..03}", { onlyDirectories: true }), TypeError);
  assert.throws(() => globSync("app-{1..5..2}", { onlyDirectories: true }), TypeError);
  assert.throws(() => getRootDirs({
    cwd: process.cwd(),
    settings: { next: { rootDir: "!(app)" } },
  }), /Leading negative rootDir extglobs are unsupported/);
  assert.deepEqual(globSync("!app", { onlyDirectories: true }), []);
});
