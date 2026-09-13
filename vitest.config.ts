import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Repository Vitest suites live under tests/. Cognitive OS evaluator files
    // use node:test and are run explicitly with `node --test`; collecting them
    // as Vitest suites produces false "No test suite found" failures after
    // their Node assertions pass.
    include: ['tests/**/*.{test,spec}.ts'],
    exclude: configDefaults.exclude,
  },
});
