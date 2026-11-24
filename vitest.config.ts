// The tests run on the build (dist/test): the pages' scripts are the bundles the build makes, and each test supplies its own task consumer. `pnpm test` builds first. One file at a time, each with time to start a browser and servers.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['dist/test/*.test.js'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
