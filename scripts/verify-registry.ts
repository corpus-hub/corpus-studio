import { sweep } from '../src/main/ipc/registry.sweep'

/**
 * `npm run verify:registry` — the registry's invariant sweep.
 *
 * A plain script, not a gate. Run it when a domain has been migrated, or when
 * asked for; every rule it checks has a comment in `registry.sweep.ts` naming
 * the specific thing that nearly shipped without it.
 */
const failures = sweep()

if (failures.length === 0) {
  // eslint-disable-next-line no-console
  console.log('[verify:registry] clean')
  process.exit(0)
}

for (const f of failures) {
  // eslint-disable-next-line no-console
  console.error(`[${f.rule}] ${f.detail}`)
}
// eslint-disable-next-line no-console
console.error(`\n${failures.length} registry invariant failure(s)`)
process.exit(1)
