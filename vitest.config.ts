import { defineConfig } from "vitest/config";

/**
 * Root Vitest config for the Murmur server (root `src/` tree).
 *
 * Coverage gate (issue #6, "CI gates to configure"):
 *   ≥85% line coverage on `src/auth/**`, `src/api/**`, `src/dispatch/**`,
 *   and `src/composes.ts`. Other files have no gate.
 *
 * Strategy: `coverage.include` enumerates ONLY the gated paths plus the
 * already-implemented files we want to count toward coverage. The threshold
 * keys under `coverage.thresholds` use Vitest's per-glob form, so when a glob
 * matches zero files (M3, M4, M11 haven't landed yet) the threshold is a
 * silent no-op — Vitest does not fail "no files matched". This way the gate
 * activates the moment those paths exist, without churning the config.
 *
 * Currently-implemented files (`src/server.ts`, `src/index.ts`, `src/logger.ts`)
 * are intentionally NOT in `coverage.include`: the issue specifies that "other
 * files have no gate". They're still counted in the human-readable report
 * because we keep the default `all: false` (only files imported by tests are
 * reported); we add them under the unscoped sources but they don't gate.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    globals: false,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      // Only the gated paths are in `include`. Everything else falls outside
      // and therefore outside the threshold, by design.
      include: [
        "src/auth/**/*.ts",
        "src/api/**/*.ts",
        "src/dispatch/**/*.ts",
        "src/composes.ts",
      ],
      // Per-glob thresholds. Vitest treats unmatched globs as "no files,
      // no enforcement", so this is a no-op against the empty pre-M3 tree.
      thresholds: {
        "src/auth/**/*.ts": {
          lines: 85,
          functions: 85,
          branches: 75,
          statements: 85,
        },
        "src/api/**/*.ts": {
          lines: 85,
          functions: 85,
          branches: 75,
          statements: 85,
        },
        "src/dispatch/**/*.ts": {
          lines: 85,
          functions: 85,
          branches: 75,
          statements: 85,
        },
        "src/composes.ts": {
          lines: 85,
          functions: 85,
          branches: 75,
          statements: 85,
        },
      },
    },
  },
});
