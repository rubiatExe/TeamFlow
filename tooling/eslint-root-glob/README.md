# Next.js ESLint directory glob adapter

`@next/eslint-plugin-next@16.3.8` uses `fast-glob@3.3.1` only in its
[`get-root-dirs` helper](https://github.com/vercel/next.js/blob/v16.3.8/packages/eslint-plugin-next/src/utils/get-root-dirs.ts).
It calls `globSync(pattern, { onlyDirectories: true })` for a configured `rootDir`.
Its dependency chain includes `braces`, whose published versions are affected by
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

The root package overrides that one dependency for that exact plugin version with
this local adapter. The adapter uses pinned `tinyglobby@0.2.17`, which is maintained
upstream and depends on `fdir` and `picomatch` rather than `braces`. It preserves
the directory discovery behavior used by the plugin and leaves the Next.js rules
enabled. Audit checks remain unchanged.

The `file:../../../tooling/eslint-root-glob` override is resolved relative to
`node_modules/@next/eslint-plugin-next`, not the root package. The lockfile records
the portable target `tooling/eslint-root-glob`; a fresh `npm ci --ignore-scripts`
must install and resolve this link before accepting dependency updates.
With npm 10, `npm ls fast-glob` can report an invalid relative override spec even
after the link installs correctly. Release verification uses a fresh install,
the installed plugin's behavior tests, and the complete npm audit; it does not
hide or filter audit findings.

A direct alias to tinyglobby would change literal directory expansion, absolute
results, and trailing slashes. This adapter disables directory expansion,
preserves absolute and relative path spelling, and rejects unsupported options.
Padded and stepped brace ranges and leading negative extglobs are rejected
explicitly; tinyglobby handles the latter's cwd/dot-directory matches differently.
Ordinary literals, wildcards, and brace alternatives are supported. See the upstream
[library comparison](https://superchupu.dev/tinyglobby/comparison).

The repository tests exercise the installed plugin against directory fixtures,
including exact roots, wildcard roots, absolute paths, trailing slashes, and
missing directories. The override is deliberately scoped to version 16.3.8 so an
upgrade cannot silently reuse this limited API adapter for a changed caller.
Remove the adapter and override when Next.js adopts a patched dependency chain;
verify the complete npm audit and root directory tests during that upgrade.
