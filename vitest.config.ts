import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts so tests don't boot the TanStack Start / Nitro plugins.
export default defineConfig({
  test: { include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'] },
})
