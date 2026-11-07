// The one decision the launcher has to get right: what to do about a WorkBuddy
// that may already be running.
//
// It lives in its own module because `tools/launch.mjs` starts the app as soon
// as it is imported, which makes the branch impossible to test from the outside
// — and this is exactly the branch that runs hidden from the desktop shortcut,
// where a wrong answer is silent.

/**
 * @param {object} input
 * @param {number[]} input.pids      processes of the app executable right now
 * @param {object|null} input.state  contents of the launcher state file
 * @param {string} input.installDir  install directory the launcher resolved
 * @param {boolean} [input.ensure]   --ensure
 * @param {boolean} [input.restart]  --restart
 * @returns {'start'|'replace'|'noop'|'refuse'}
 */
export function decide({ pids, state, installDir, ensure = false, restart = false }) {
  if (!pids.length) return 'start'

  // A state file only counts when its process is still alive *and* it describes
  // the same install: a leftover file from another folder must not be trusted.
  const live = !!state && pids.includes(state.pid) && state.dir === installDir

  if (restart) return 'replace'
  if (ensure) return live ? 'noop' : 'replace'

  // Plain start: never touch an app the user opened themselves.
  return 'refuse'
}
