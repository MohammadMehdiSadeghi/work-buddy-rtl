// Tests for the launcher's running-instance decision.
//
// This is the branch that runs hidden from the desktop shortcut, so a wrong
// answer is silent: either it kills a WorkBuddy the user did not want killed,
// or it does nothing while the user believes the layer is applied.

import { decide } from '../tools/decide.mjs'

const DIR = 'C:/Users/x/AppData/Local/Programs/WorkBuddyAI'
const OTHER = 'D:/apps/WorkBuddyAI'

const results = []
const expect = (name, actual, wanted) => results.push({ name, actual, wanted, ok: actual === wanted })

// --- nothing running ---------------------------------------------------------
expect('closed app is started', decide({ pids: [], state: null, installDir: DIR }), 'start')
expect('closed app with a stale state file is still started', decide({ pids: [], state: { pid: 1, dir: DIR }, installDir: DIR }), 'start')

// --- a patched app -----------------------------------------------------------
expect(
  'live launcher plus --ensure does nothing',
  decide({ pids: [10], state: { pid: 10, dir: DIR }, installDir: DIR, ensure: true }),
  'noop'
)
expect(
  'live launcher plus --restart replaces it',
  decide({ pids: [10], state: { pid: 10, dir: DIR }, installDir: DIR, restart: true }),
  'replace'
)

// --- an app opened from its own icon -----------------------------------------
expect(
  'unpatched app plus --ensure is replaced',
  decide({ pids: [10], state: null, installDir: DIR, ensure: true }),
  'replace'
)
expect(
  'unpatched app without a flag is left alone',
  decide({ pids: [10], state: null, installDir: DIR }),
  'refuse'
)
expect(
  'unpatched app without a flag is left alone even with --quiet',
  decide({ pids: [10], state: null, installDir: DIR, ensure: false }),
  'refuse'
)

// --- state files that must not be trusted ------------------------------------
expect(
  'a state file for another install is not trusted',
  decide({ pids: [10], state: { pid: 10, dir: OTHER }, installDir: DIR, ensure: true }),
  'replace'
)
expect(
  'a state file whose process died is not trusted',
  decide({ pids: [11], state: { pid: 10, dir: DIR }, installDir: DIR, ensure: true }),
  'replace'
)
expect(
  'a missing install dir in the state file is not trusted',
  decide({ pids: [10], state: { pid: 10 }, installDir: DIR, ensure: true }),
  'replace'
)

// --- output ------------------------------------------------------------------
let failed = 0
for (const r of results) {
  if (r.ok) console.log(`ok    ${r.name}: ${JSON.stringify(r.actual)}`)
  else {
    failed++
    console.log(`FAIL  ${r.name}: ${JSON.stringify(r.actual)} (wanted ${JSON.stringify(r.wanted)})`)
  }
}
console.log(failed ? `\n${failed} of ${results.length} failed` : `\nall ${results.length} passed`)
process.exit(failed ? 1 : 0)
