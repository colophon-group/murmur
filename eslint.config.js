// ESLint 9 flat config. See https://eslint.org/docs/latest/use/configure/configuration-files
//
// Murmur lint policy (M1 quality gates):
//   - `@typescript-eslint/no-explicit-any: error` — no `any`, anywhere.
//   - `no-console: error` — no `console.log`/`console.warn` in production code.
//     `src/logger.ts` is the single sanctioned escape hatch (uses `console.error`
//     to write JSON-line logs to stderr).
//   - `unused-imports/no-unused-imports: error` — kill stale imports.
//   - `unused-imports/no-unused-vars: error` — kill stale locals.
//
// Cross-file unused-export detection runs separately via `ts-prune`
// (see `scripts/check-unused-exports.sh`), invoked by `pnpm lint`.

import tseslint from "typescript-eslint";
import unusedImports from "eslint-plugin-unused-imports";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "packages/**/dist/**",
      "**/*.d.ts",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts", "**/*.config.ts", "**/*.config.js"],
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      // Drop the base typescript-eslint rule in favour of the unused-imports variant.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // The logger is the sanctioned home of `console.error`.
    files: ["src/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Tests may use `any` casts and console for debugging; relax the rules.
    files: ["**/*.test.ts", "test/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Workspace packages own their own lint config; skip them here.
    ignores: ["packages/**"],
  },
);
