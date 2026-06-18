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
    // Pre-seed SHADOW_MODE so that service test dotenv loads (which may set
    // SHADOW_MODE=true from clients/scm/.env) do not leak into core tests.
    env: {
      SHADOW_MODE: 'false',
    },
  },
});
