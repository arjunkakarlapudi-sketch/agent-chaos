import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      'agent-chaos': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
})
