/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Vitest config — resolves the @/ path alias used throughout the project.
 * 
 * Without this, imports like `@/lib/streams/types` would fail in tests.
 * The alias matches what's defined in tsconfig.json paths.
 */
export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
