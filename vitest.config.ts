import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share a Postgres database; run sequentially
    // to prevent cross-test cleanup interference.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
