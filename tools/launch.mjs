#!/usr/bin/env node
// Launch WorkBuddy with the Persian/RTL layer injected at runtime.
//
// Why not patch app.asar? WorkBuddy enables Electron's ASAR integrity
// validation: changing app.asar makes the app refuse to start. This launcher
// keeps the app untouched — it starts it with a local DevTools port, connects
// over the Chrome DevTools Protocol and injects the stylesheet (fonts inlined)
// plus the direction script into every renderer window.

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findInstalls } from './locate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PATCH = path.join(REPO, 'patch')

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const flag = (name) => argv.includes(name)
const quiet = flag('--quiet')
const status = flag('--status')

const log = (...args) => {
  if (!quiet) console.log(...args)
}

function findExe(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  return (
    entries
      .filter((e) => e.isFile() && /\.exe$/i.test(e.name) && /workbuddy/i.test(e.name))
      .map((e) => path.join(dir, e.name))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0] || null
  )
}

function running() {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq WorkBuddyAI.exe', '/NH'], { encoding: 'utf8' })
      return /WorkBuddyAI\.exe/i.test(out.stdout || '')
    }
    const out = spawnSync('ps', ['-A'], { encoding: 'utf8' })
    return /workbuddy/i.test(out.stdout || '')
  } catch {
    return false
  }
}

function loadPatch() {
  const cssFile = path.join(PATCH, 'workbuddy-rtl.css')
  const jsFile = path.join(PATCH, 'workbuddy-rtl.js')
  for (const file of [cssFile, jsFile]) {
    if (!fs.existsSync(file)) throw new Error(`patch file missing: ${file}`)
  }
  const css = fs.readFileSync(cssFile, 'utf8').replace(/\.\/fonts\/([A-Za-z0-9._-]+\.woff2)/g, (_, name) => {
    const file = path.join(PATCH, 'fonts', name)
    return `data:font/woff2;base64,${fs.readFileSync(file).toString('base64')}`
  })
  return { css, js: fs.readFileSync(jsFile, 'utf8') }
}

function bootstrapSource(css, js) {
  return `(() => {
  try {
    const CSS = ${JSON.stringify(css)}
    const JS = ${JSON.stringify(js)}
    const apply = () => {
      try {
        let style = document.getElementById('workbuddy-rtl-style')
        if (!style) {
          style = document.createElement('style')
          style.id = 'workbuddy-rtl-style'
          ;(document.head || document.documentElement).appendChild(style)
        }
        if (style.textContent !== CSS) style.textContent = CSS
      if (!window.__workbuddyRtl) (0, eval)(JS)
      } catch {}
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', apply, { once: true })
    }
    apply()
  } catch {}
})()`
}

async function listTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
    if (!res.ok) return []
    return await res.json()
  } catch {
    return []
  }
}

// Don't turn an already-running WorkBuddy into a broken injector: CDP is only
// reachable from a port the launcher spawns itself, and WorkBuddy's
// single-instance behavior would make every extra copy behave oddly.
async function inject(target, source) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  try {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = reject
    })

    let seq = 0
    const pending = new Map()
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    }
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++seq
        pending.set(id, resolve)
        socket.send(JSON.stringify({ id, method, params }))
      })

    await send('Page.enable')
    await send('Page.addScriptToEvaluateOnNewDocument', { source })
    await send('Runtime.evaluate', { expression: source, awaitPromise: false })
  } catch (err) {
    try {
      socket.close()
    } catch {}
    throw err
  }
}

async function main() {
  const rootArg = arg('--root')
  const install = rootArg ? { dir: path.resolve(rootArg) } : findInstalls()[0]

  if (!install) {
    console.error('WorkBuddy not found. Pass --root "<install folder>".')
    process.exit(1)
  }

  const exe = findExe(install.dir)
  if (!exe) {
    console.error(`WorkBuddy executable not found in ${install.dir}`)
    process.exit(1)
  }

  // Don't turn an already-running app into a broken injector: CDP is only
  // reachable from a port that the launcher spawns itself, and WorkBuddy's
  // single-instance behaviour would make every extra copy behave oddly.
  if (running()) {
    console.log(`Install    : ${install.dir}`)
    console.log(`Executable : ${exe}`)
    console.log(`Running    : ${running() ? 'yes' : 'no'}`)
    console.log('RTL layer  : injected by tools/launch.mjs at startup')
    return
  }

  const { css, js } = loadPatch()
  const source = bootstrapSource(css, js)
  const port = Number(arg('--port')) || 19000 + Math.floor(Math.random() * 20000)

  log(`starting ${path.basename(exe)} (CDP port ${port})`)
  const child = spawn(exe, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
    cwd: install.dir,
    stdio: 'ignore',
  })

  let exited = false
  child.on('exit', () => {
    exited = true
  })

  const deadline = Date.now() + 120000
  let targets = []
  while (Date.now() < deadline) {
    if (exited) {
      console.error('WorkBuddy exited before its window was ready (another instance may be open).')
      process.exit(1)
    }
    targets = (await listTargets(port)).filter((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url))
    if (targets.length) break
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!targets.length) {
    console.error('Timed out waiting for the WorkBuddy window.')
    child.kill()
    process.exit(1)
  }

const injected = new Map()
  for (const target of targets) {
    try {
      injected.set(target.id, await inject(target, source))
      log(`injected: ${target.title || target.url}`)
    } catch (err) {
      console.error(`could not inject into ${target.url}: ${err.message}`)
    }
  }
}

function loopNewWindows() {
  if (exited) return
  const timer = setInterval(async () => {
    const pages = (await listTargets(port)).filter((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url))
    for (const target of pages) {
      if (injected.has(target.id)) continue
      try {
        injected.set(target.id, await inject(target, source))
        log(`injected: ${target.title || target.url}`)
      } catch {}
    }
  }, 2000)

  child.on('exit', () => {
    clearInterval(timer)
    for (const socket of injected.values()) {
      try {
        socket.close()
      } catch {}
    }
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
