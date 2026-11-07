#!/usr/bin/env node
// Launch WorkBuddy with the Persian/RTL layer injected at runtime.
//
// Why not patch app.asar? WorkBuddy enables Electron's ASAR integrity
// validation: changing app.asar makes the app refuse to start. This launcher
// keeps the app untouched — it starts it with a local DevTools port and injects
// the stylesheet (fonts inlined) plus the direction script into every renderer
// window, now and for every window opened later.
//
//   node tools/launch.mjs                 start the app with the layer
//   node tools/launch.mjs --status        report state, never starts anything
//   node tools/launch.mjs --check         verify the patch, exit 1 if broken
//   node tools/launch.mjs --restart       close a running instance first
//   node tools/launch.mjs --ensure        make the layer live, restarting only
//                                         when the running copy does not have it
//   node tools/launch.mjs --root <dir> --port <n> --quiet
//   node tools/launch.mjs -- --user-data-dir=...   extra switches for the app

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findInstalls } from './locate.mjs'
import { readEntry } from './asar.mjs'
import { decide } from './decide.mjs'
import {
  checkPatch,
  cssSource,
  inject,
  isTarget,
  listTargets,
  loadPatch,
  patchId,
  probeFont,
  waitForTargets,
} from './inject.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PATCH_DIR = path.resolve(HERE, '..', 'patch')
const STATE_FILE = path.join(os.tmpdir(), 'workbuddy-rtl.json')
const LOG_FILE = path.join(os.tmpdir(), 'workbuddy-rtl.log')

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes(name)
const quiet = has('--quiet') || has('-q')
// --ensure is what the desktop shortcut uses: "make sure the layer is live".
// It is the only mode allowed to close a WorkBuddy it did not start, because
// the user's intent is exactly that, and it does nothing when already patched.
const ensure = has('--ensure')

// Everything after `--` is handed to the app untouched.
const split = argv.indexOf('--')
const appArgs = split >= 0 ? argv.slice(split + 1) : []

// The shortcut runs this hidden, so every line also goes to a log file: when
// something fails there is a file to look at instead of an empty window.
function record(line) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 200 * 1024) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
    }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()}  ${line}\n`)
  } catch {}
}

const log = (...args) => {
  record(args.join(' '))
  if (!quiet) console.log(...args)
}

const fail = (...args) => {
  record(`ERROR ${args.join(' ')}`)
  console.error(...args)
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- install ---

function findExe(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const exes = entries
    .filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name) && /workbuddy/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
  if (!exes.length) return null
  return exes.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
}

function processes() {
  if (process.platform === 'win32') {
    const out = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    const list = []
    for (const line of (out.stdout || '').split(/\r?\n/)) {
      const match = line.match(/^"([^"]+)","(\d+)"/)
      if (match) list.push({ name: match[1], pid: Number(match[2]) })
    }
    return list
  }
  const out = spawnSync('ps', ['-Ao', 'pid=,comm='], { encoding: 'utf8' })
  return (out.stdout || '')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && /^\d+$/.test(parts[0]))
    .map((parts) => ({ pid: Number(parts[0]), name: parts.slice(1).join(' ') }))
}

const pidsOf = (exeName) =>
  processes()
    .filter((proc) => path.basename(proc.name).toLowerCase() === exeName.toLowerCase())
    .map((proc) => proc.pid)

function terminate(pids) {
  for (const pid of pids) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true })
    } else {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
  }
}

async function waitGone(exeName, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!pidsOf(exeName).length) return true
    await delay(250)
  }
  return !pidsOf(exeName).length
}

// ------------------------------------------------------------------ state ---

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch {}
}

function clearState() {
  try {
    fs.unlinkSync(STATE_FILE)
  } catch {}
}

// ------------------------------------------------------------------- main ---

function describe(install, exe, pids, patch, build) {
  const state = readState()
  const live = state && pids.includes(state.pid)
  console.log(`Install    : ${install.dir}${install.version ? `  (v${install.version})` : ''}`)
  console.log(`Executable : ${exe}`)
  console.log(`Running    : ${pids.length ? `yes  (pid ${pids.join(', ')})` : 'no'}`)
  console.log(
    `Launcher   : ${live ? `active  (pid ${state.pid}, CDP port ${state.port}, build ${state.patch || '?'})` : 'not active'}`
  )
  console.log(`Patch      : ${patch.ok ? `ok  (build ${build})` : `incomplete — ${patch.problems.join('; ')}`}`)
  console.log(`Log        : ${LOG_FILE}`)
  if (pids.length && !live) {
    console.log('')
    console.log('This WorkBuddy was not started by the launcher, so the layer is not applied.')
    console.log('Close it completely (tray included) and open the "WorkBuddy RTL" shortcut,')
    console.log('or run: node tools/launch.mjs --restart')
  }
}

async function main() {
  const rootArg = arg('--root')
  let install = rootArg ? { dir: path.resolve(rootArg), version: '' } : findInstalls()[0]

  if (!install) {
    fail('WorkBuddy not found. Pass --root "<install folder>".')
    process.exit(1)
  }

  if (!install.version) {
    for (const candidate of [path.join(install.dir, 'resources', 'app.asar'), path.join(install.dir, 'app.asar')]) {
      try {
        install = { ...install, version: JSON.parse(readEntry(candidate, 'package.json').toString('utf8')).version || '' }
        break
      } catch {}
    }
  }

  const exe = findExe(install.dir)
  if (!exe) {
    fail(`WorkBuddy executable not found in ${install.dir}`)
    process.exit(1)
  }

  const exeName = path.basename(exe)
  const patch = checkPatch(PATCH_DIR)
  const build = patchId(PATCH_DIR)

  if (has('--check')) {
    describe(install, exe, pidsOf(exeName), patch, build)
    process.exit(patch.ok ? 0 : 1)
  }

  if (has('--status')) {
    describe(install, exe, pidsOf(exeName), patch, build)
    return
  }

  if (!patch.ok) {
    fail(`patch is incomplete: ${patch.problems.join('; ')}`)
    process.exit(1)
  }

  const pids = pidsOf(exeName)
  const state = readState()

  switch (decide({ pids, state, installDir: install.dir, ensure, restart: has('--restart') })) {
    case 'noop':
      log(`already running with the layer (pid ${state.pid}, build ${state.patch || '?'})`)
      return
    case 'refuse':
      console.log(`WorkBuddy is already running (pid ${pids.join(', ')}).`)
      console.log('The RTL layer is only injected when the app is started by this launcher.')
      console.log('Close WorkBuddy and run this again, or run it with --restart.')
      return
    case 'replace':
      log('WorkBuddy is running without the layer; replacing that instance...')
      break
  }

  if (pids.length) {
    log('closing the running instance...')
    terminate(pids)
    if (!(await waitGone(exeName, 10000))) {
      fail('could not close the running WorkBuddy instance')
      process.exit(1)
    }
  }

  const { css, js } = loadPatch(PATCH_DIR)
  const sources = { css: cssSource(css), js }
  const port = Number(arg('--port')) || 19000 + Math.floor(Math.random() * 20000)

  log(`starting ${exeName} (CDP port ${port})`)
  const child = spawn(exe, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', ...appArgs], {
    cwd: install.dir,
    stdio: 'ignore',
    windowsHide: true,
  })

  if (!child.pid) {
    fail('could not start WorkBuddy')
    process.exit(1)
  }

  let exited = false
  child.on('exit', () => {
    exited = true
  })
  writeState({ pid: child.pid, port, patch: build, startedAt: new Date().toISOString(), dir: install.dir })

  const { targets, dead } = await waitForTargets(port, { timeout: 120000, isDead: () => exited })
  if (dead) {
    clearState()
    fail('WorkBuddy exited before its window was ready (another instance may be open).')
    process.exit(1)
  }
  if (!targets.length) {
    clearState()
    try {
      child.kill()
    } catch {}
    fail('timed out waiting for the WorkBuddy window')
    process.exit(1)
  }

  const sockets = new Map()
  let fontOk = false
  for (const target of targets) {
    try {
      const socket = await inject(target, sources)
      sockets.set(target.id, socket)
      log(`injected: ${target.title || target.url}`)
      const font = await probeFont(socket)
      if (font && font.loaded > 0) fontOk = true
      if (font) log(`font: ${font.loaded}/${font.faces} faces loaded, vazir=${font.vazir}`)
      else log('font: could not be verified in this renderer')
    } catch (err) {
      fail(`could not inject into ${target.url}: ${err.message}`)
    }
  }

  if (!sockets.size) {
    clearState()
    fail('the layer was not injected into any window')
    process.exit(1)
  }

  // Injection can succeed while the font silently fails to decode, and the
  // result looks exactly like an unpatched app. Say so instead of pretending.
  if (!fontOk) {
    log('WARNING the Persian font did not report as loaded — text may fall back to a system font')
  }

  log(`RTL layer active (build ${build}). Leave this process running; it stops with WorkBuddy.`)

  // Settings, conversations and every new window get their own renderer.
  const timer = setInterval(async () => {
    if (exited) return
    for (const target of (await listTargets(port)).filter(isTarget)) {
      if (sockets.has(target.id)) continue
      try {
        sockets.set(target.id, await inject(target, sources))
        log(`injected: ${target.title || target.url}`)
      } catch {}
    }
  }, 1500)

  const cleanup = () => {
    clearInterval(timer)
    for (const socket of sockets.values()) {
      try {
        socket.close()
      } catch {}
    }
    sockets.clear()
    clearState()
  }

  child.on('exit', () => {
    cleanup()
    process.exit(0)
  })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      cleanup()
      process.exit(0)
    })
  }
}

main().catch((err) => {
  clearState()
  fail(err.message || err)
  process.exit(1)
})
