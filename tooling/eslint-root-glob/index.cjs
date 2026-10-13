"use strict";

// The upstream plugin loads this synchronous CommonJS module with require().
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isAbsolute } = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { globSync: tinyGlobSync, isDynamicPattern } = require("tinyglobby");

// This is only the get-root-dirs contract in @next/eslint-plugin-next 16.3.8.
// Refuse a changed caller instead of silently treating this as full fast-glob.
function globSync(pattern, options) {
  if (
    typeof pattern !== "string" ||
    !options ||
    options.onlyDirectories !== true ||
    Object.keys(options).some((key) => key !== "onlyDirectories")
  ) {
    throw new TypeError("The Next.js root glob adapter only supports directory globSync calls");
  }
  // Picomatch does not support padded or stepped brace ranges. Reject these
  // explicitly instead of discovering a different set of application roots.
  for (const [, range] of pattern.matchAll(/\{([^{}]*\.\.[^{}]*)\}/g)) {
    const bounds = range.split("..");
    if (bounds.length > 2 || bounds.some((bound) => /^-?0\d+$/.test(bound))) {
      throw new TypeError("Padded and stepped rootDir brace ranges are unsupported");
    }
  }
  // A leading negative extglob has different cwd/dot-directory semantics in
  // tinyglobby. Fail explicitly rather than silently adding or losing roots.
  if (pattern.startsWith("!(")) {
    throw new TypeError("Leading negative rootDir extglobs are unsupported");
  }
  if (pattern.startsWith("!")) return [];

  const matches = tinyGlobSync(pattern, {
    onlyDirectories: true,
    expandDirectories: false,
    absolute: isAbsolute(pattern),
  });

  // fast-glob preserves a literal root's spelling, including ./ and a final /.
  if (!isDynamicPattern(pattern)) return matches.length ? [pattern] : [];

  return matches.map((entry) => {
    const directory = entry.replace(/\/+$/, "") || "/";
    return pattern.startsWith("./") && !directory.startsWith("./")
      ? `./${directory}`
      : directory;
  });
}

module.exports = { globSync };
