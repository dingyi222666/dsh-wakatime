/**
 * Standalone tsdown config for the dsh-wakatime external plugin — a host-only
 * bundle that emits one self-contained ESM artifact, `lib/index.js`.
 *
 * The plugin is loaded by a dsh profile's loader through the profile's
 * dependency graph plus the flat module fallback under `$DSH_HOME/profiles/
 * node_modules`, which symlinks every package in the dsh app's dependency
 * closure. `@deepseek-ai/*` peers therefore resolve at runtime without being
 * bundled; the emitted module imports only node builtins plus the schemastery
 * config schema.
 */
import type { UserConfig } from 'tsdown'

export default [
  {
    name: 'dsh-wakatime',
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
] satisfies UserConfig[]
