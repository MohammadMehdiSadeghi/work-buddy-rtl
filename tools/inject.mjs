#!/usr/bin/env node
// Runtime injection over the Chrome DevTools Protocol.
//
// WorkBuddy enables Electron's ASAR integrity validation, so the layer cannot
// live inside app.asar. Instead the app is started with a loopback debugging
// port and every renderer gets the stylesheet and the direction script
// injected into it — the archive on disk is never touched.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const TARGET = /renderer\/index\.html/i
export const isTarget = (target) => target.type === 'page' && TARGET.test(target.url || '')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --------------------------------------------------------------- patch files ---

export function checkPatch(patchDir) {
  const problems = []
  const css = path.join(patchDir, 'workbuddy-rtl.css')
  const js = path.join(patchDir, 'workbuddy-rtl.js')
  const font = path.join(patchDir, 'fonts', 'Vazir-Variable.woff2')

  for (const [file, label] of [
    [css, 'patch/workbuddy-rtl.css'],
    [js, 'patch/workbuddy-rtl.js'],
    [font, 'patch/fonts/Vazir-Variable.woff2'],
  ]) {
    if (!fs.existsSync(file)) problems.push(`missing ${label}`)
  }
  if (problems.length) return { ok: false, problems }

  const cssText = fs.readFileSync(css, 'utf8')
  if (!/@font-face/.test(cssText)) problems.push('CSS has no @font-face')
  if ((cssText.match(/\{/g) || []).length !== (cssText.match(/\}/g) || []).length) {
    problems.push('CSS braces are unbalanced')
  }

  try {
    new Function(fs.readFileSync(js, 'utf8'))
  } catch (err) {
    problems.push(`direction script does not parse (${err.message})`)
  }

  const fontBuffer = fs.readFileSync(font)
  if (fontBuffer.subarray(0, 4).toString('latin1') !== 'wOF2') problems.push('font is not a woff2 file')
  if (fontBuffer.length < 20 * 1024) problems.push('font file looks truncated')

  return { ok: problems.length === 0, problems }
}

/** Short hash of the patch, so "which build am I running?" has an answer. */
export function patchId(patchDir) {
  const hash = createHash('sha1')
  for (const file of ['workbuddy-rtl.css', 'workbuddy-rtl.js']) {
    hash.update(fs.readFileSync(path.join(patchDir, file)))
  }
  return hash.digest('hex').slice(0, 7)
}

/** Read the patch and inline the font, so the payload needs no file:// access. */
export function loadPatch(patchDir) {
  const checked = checkPatch(patchDir)
  if (!checked.ok) throw new Error(`patch is incomplete: ${checked.problems.join('; ')}`)

  const css = fs
    .readFileSync(path.join(patchDir, 'workbuddy-rtl.css'), 'utf8')
    .replace(/\.\/fonts\/([A-Za-z0-9._-]+\.woff2)/g, (_, name) => {
      const file = path.join(patchDir, 'fonts', name)
      return `data:font/woff2;base64,${fs.readFileSync(file).toString('base64')}`
    })

  return { css, js: fs.readFileSync(path.join(patchDir, 'workbuddy-rtl.js'), 'utf8'), id: patchId(patchDir) }
}

// ------------------------------------------------------------------ payload ---

// One self-contained IIFE, no eval(): a Content-Security-Policy without
// 'unsafe-eval' would silently break an eval-based bootstrap.
export function cssSource(css) {
  return `(() => {
  try {
    const CSS = ${JSON.stringify(css)};
    const apply = () => {
      try {
        const head = document.head || document.documentElement;
        if (!head) return;
        let style = document.getElementById('workbuddy-rtl-style');
        if (!style) {
          style = document.createElement('style');
          style.id = 'workbuddy-rtl-style';
          head.appendChild(style);
        }
        if (style.textContent !== CSS) style.textContent = CSS;
      } catch (err) {}
    };
    apply();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', apply, { once: true });
      setTimeout(apply, 400);
    } else {
      setTimeout(apply, 0);
    }
  } catch (err) {}
})()`
}

// ---------------------------------------------------------------------- CDP ---

export async function listTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) })
    if (!res.ok) return []
    return await res.json()
  } catch {
    return []
  }
}

/** Open a CDP session on one target. Exported so tools/tests can evaluate JS. */
export async function connectTarget(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP socket timeout')), 5000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('CDP socket error'))
      },
      { once: true }
    )
  })

  let seq = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    const resolve = message.id && pending.get(message.id)
    if (resolve) {
      pending.delete(message.id)
      resolve(message)
    }
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, 10000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(`CDP ${method}: ${message.error.message}`))
        else resolve(message)
      })
      socket.send(JSON.stringify({ id, method, params }))
    })

  return { socket, send }
}

/** Inject into one target and keep the socket open (the session owns the patch). */
export async function inject(target, sources) {
  const { socket, send } = await connectTarget(target)
  try {
    await send('Page.enable')
    for (const source of [sources.css, sources.js]) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source })
    }
    await send('Runtime.evaluate', { expression: sources.css })
    await send('Runtime.evaluate', { expression: sources.js })
    return socket
  } catch (err) {
    try {
      socket.close()
    } catch {}
    throw err
  }
}

/** Inject into every matching page currently open. */
export async function injectAll(port, sources) {
  const sockets = new Map()
  for (const target of (await listTargets(port)).filter(isTarget)) {
    try {
      sockets.set(target.id, await inject(target, sources))
    } catch {}
  }
  return sockets
}

/** Wait until the renderer of a freshly started app shows up. */
export async function waitForTargets(port, { timeout = 120000, isDead = () => false } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (isDead()) return { targets: [], dead: true }
    const targets = (await listTargets(port)).filter(isTarget)
    if (targets.length) return { targets, dead: false }
    await delay(400)
  }
  return { targets: [], dead: false }
}
