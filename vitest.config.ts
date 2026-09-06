import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These fixtures use Node's built-in test runner and are verified
    // separately with `node --test`; collecting them as Vitest suites makes
    // Vitest report a false "No test suite found" failure.
    exclude: [
      ...configDefaults.exclude,
      'cognitive-os/**/graders/tests/**',
    ],
  },
});
