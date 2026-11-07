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
//   node tools/launch.mjs --root <dir> --port <n> --quiet
//   node tools/launch.mjs -- --user-data-dir=...   extra switches for the app

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findInstalls } from './locate.mjs'
import { readEntry } from './asar.mjs'
import { checkPatch, cssSource, inject, isTarget, listTargets, loadPatch, waitForTargets } from './inject.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PATCH_DIR = path.resolve(HERE, '..', 'patch')
const STATE_FILE = path.join(os.tmpdir(), 'workbuddy-rtl.json')

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes(name)
const quiet = has('--quiet') || has('-q')

// Everything after `--` is handed to the app untouched.
const split = argv.indexOf('--')
const appArgs = split >= 0 ? argv.slice(split + 1) : []

const log = (...args) => {
  if (!quiet) console.log(...args)
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

function describe(install, exe, pids, patch) {
  const state = readState()
  const live = state && pids.includes(state.pid)
  console.log(`Install    : ${install.dir}${install.version ? `  (v${install.version})` : ''}`)
  console.log(`Executable : ${exe}`)
  console.log(`Running    : ${pids.length ? `yes  (pid ${pids.join(', ')})` : 'no'}`)
  console.log(`Launcher   : ${live ? `active  (pid ${state.pid}, CDP port ${state.port})` : 'not active'}`)
  console.log(`Patch      : ${patch.ok ? 'ok' : `incomplete — ${patch.problems.join('; ')}`}`)
}

async function main() {
  const rootArg = arg('--root')
  let install = rootArg ? { dir: path.resolve(rootArg), version: '' } : findInstalls()[0]

  if (!install) {
    console.error('WorkBuddy not found. Pass --root "<install folder>".')
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
    console.error(`WorkBuddy executable not found in ${install.dir}`)
    process.exit(1)
  }

  const exeName = path.basename(exe)
  const patch = checkPatch(PATCH_DIR)

  if (has('--check')) {
    describe(install, exe, pidsOf(exeName), patch)
    process.exit(patch.ok ? 0 : 1)
  }

  if (has('--status')) {
    describe(install, exe, pidsOf(exeName), patch)
    return
  }

  if (!patch.ok) {
    console.error(`patch is incomplete: ${patch.problems.join('; ')}`)
    process.exit(1)
  }

  const pids = pidsOf(exeName)
  if (pids.length && !has('--restart')) {
    console.log(`WorkBuddy is already running (pid ${pids.join(', ')}).`)
    console.log('The RTL layer is only injected when the app is started by this launcher.')
    console.log('Close WorkBuddy and run this again, or run it with --restart.')
    return
  }

  if (pids.length) {
    log('closing the running instance...')
    terminate(pids)
    if (!(await waitGone(exeName, 10000))) {
      console.error('could not close the running WorkBuddy instance')
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
    console.error('could not start WorkBuddy')
    process.exit(1)
  }

  let exited = false
  child.on('exit', () => {
    exited = true
  })
  writeState({ pid: child.pid, port, startedAt: new Date().toISOString(), dir: install.dir })

  const { targets, dead } = await waitForTargets(port, { timeout: 120000, isDead: () => exited })
  if (dead) {
    clearState()
    console.error('WorkBuddy exited before its window was ready (another instance may be open).')
    process.exit(1)
  }
  if (!targets.length) {
    clearState()
    try {
      child.kill()
    } catch {}
    console.error('timed out waiting for the WorkBuddy window')
    process.exit(1)
  }

  const sockets = new Map()
  for (const target of targets) {
    try {
      sockets.set(target.id, await inject(target, sources))
      log(`injected: ${target.title || target.url}`)
    } catch (err) {
      console.error(`could not inject into ${target.url}: ${err.message}`)
    }
  }

  log('RTL layer active. Leave this process running; it stops with WorkBuddy.')

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
  console.error(err.message || err)
  process.exit(1)
})
