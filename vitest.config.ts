import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.system.test.ts', 'src/**/*.live.test.ts'],
        },
      },
      {
        test: {
          name: 'system',
          environment: 'node',
          include: ['src/**/*.system.test.ts'],
          // WHY serial: system tests open real SQLite files, bind loopback
          // ports and run local HTTP servers. Running them in parallel makes
          // a port or file-lock collision look like a product failure.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // WHY every source file is in the denominator: imported-files-only
      // coverage rewards untested modules by leaving them out of the total.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      // WHY these floors: the complete 2026-09-11 Node 24 coverage run measured
      // 93.78% statements, 84.70% branches, 96.27% functions and 96.70% lines
      // over every source file (including source-only testing helpers). Whole
      // percentages just below that baseline catch backsliding without treating
      // one rounding digit as a behavior regression. Like the sibling packages,
      // keep the denominator explicit and ratchet only from a real full run.
      thresholds: { statements: 93, branches: 84, functions: 96, lines: 96 },
    },
  },
})
