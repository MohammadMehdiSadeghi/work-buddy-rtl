import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connectTarget, cssSource, inject, isTarget, listTargets, loadPatch } from '../tools/inject.mjs'
import { findBrowser } from './browser-path.mjs'

// End-to-end check of the injection path in a real Chromium: the same CDP
// calls the launcher makes, against a fixture that mimics WorkBuddy's DOM.
// Skips itself when no Chrome/Edge is installed.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FIXTURE = path.join(os.tmpdir(), 'workbuddy-rtl-fixture')
const PORT = 9411 + Math.floor(Math.random() * 400)

const exe = findBrowser()
if (!exe) {
  console.log('skip: no Chrome or Edge found')
  process.exit(0)
}

fs.mkdirSync(path.join(FIXTURE, 'renderer'), { recursive: true })
fs.writeFileSync(
  path.join(FIXTURE, 'renderer', 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font-family: "PingFang SC", system-ui, -apple-system, "Segoe UI", sans-serif; }
  .cb-markdown p { text-align: left; }
  .cb-sidebar-btn { text-align: center; }
</style></head><body>
  <aside class="sk-sidebar"><button class="cb-sidebar-btn" id="side">گفتگوی جدید</button></aside>
  <div class="cb-chat-message--assistant">
    <div class="cb-chat-message-bubble cb-markdown">
      <p id="fa">سلام، این یک پیام فارسی است.</p>
      <p id="en">This is an English message.</p>
      <ul id="list"><li id="li1">آیتم اول</li><li id="li2">Second item</li></ul>
      <div class="cb-markdown-pre"><pre><code id="code">سلام()</code></pre></div>
    </div>
  </div>
  <textarea id="composer"></textarea>
</body></html>`
)

const chrome = spawn(
  exe,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${path.join(FIXTURE, 'profile')}`,
    `--remote-debugging-port=${PORT}`,
    `file:///${path.join(FIXTURE, 'renderer', 'index.html').replace(/\\/g, '/')}`,
  ],
  { stdio: 'ignore' }
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let target = null
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250)
  target = (await listTargets(PORT)).filter(isTarget)[0]
}
if (!target) {
  console.log('FAIL  the browser never exposed a renderer target')
  chrome.kill()
  process.exit(1)
}

const { css, js } = loadPatch(path.join(ROOT, 'patch'))
const socket = await inject(target, { css: cssSource(css), js })

const session = await connectTarget(target)
const evaluate = async (expression) => {
  const message = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (message.result?.exceptionDetails) return `ERROR: ${message.result.exceptionDetails.text}`
  return message.result?.result?.value
}

await sleep(700)

const results = []
const expect = (name, actual, wanted) => results.push({ name, actual, wanted, ok: actual === wanted })

expect('stylesheet is in the document', await evaluate(`!!document.getElementById('workbuddy-rtl-style')`), true)
expect('persian paragraph dir', await evaluate(`document.getElementById('fa').getAttribute('dir')`), 'rtl')
expect('persian paragraph alignment', await evaluate(`getComputedStyle(document.getElementById('fa')).textAlign`), 'right')
expect('english paragraph dir', await evaluate(`document.getElementById('en').getAttribute('dir')`), null)
expect('persian list item', await evaluate(`document.getElementById('li1').getAttribute('dir')`), 'rtl')
expect('english list item', await evaluate(`document.getElementById('li2').getAttribute('dir')`), null)
expect('code stays ltr', await evaluate(`getComputedStyle(document.getElementById('code')).direction`), 'ltr')
expect('sidebar label', await evaluate(`document.getElementById('side').getAttribute('dir')`), 'rtl')
expect('sidebar keeps its centring', await evaluate(`getComputedStyle(document.getElementById('side')).textAlign`), 'center')
expect(
  'the app font stack resolves to Vazir for Persian',
  await evaluate(`(async () => {
    await document.fonts.ready
    const measure = (family) => {
      const el = document.createElement('span')
      el.style.cssText = 'position:absolute;visibility:hidden;font-size:32px;font-family:' + family
      el.textContent = 'سلام دنیا ۱۲۳'
      document.body.appendChild(el)
      const width = el.getBoundingClientRect().width
      el.remove()
      return width
    }
    const stack = '"PingFang SC", system-ui, -apple-system, "Segoe UI", sans-serif'
    return Math.abs(measure(stack) - measure('system-ui')) > 1
  })()`),
  true
)
expect(
  'composer follows the text',
  await evaluate(`(() => {
    const el = document.getElementById('composer')
    el.value = 'سلام'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return new Promise((resolve) => setTimeout(() => resolve(el.getAttribute('dir')), 300))
  })()`),
  'rtl'
)

// A reload must re-apply the layer through addScriptToEvaluateOnNewDocument.
await evaluate(`setTimeout(() => location.reload(), 0), true`)
await sleep(1800)
const reloaded = (await listTargets(PORT)).filter(isTarget)[0]
if (reloaded) {
  const after = await connectTarget(reloaded)
  const message = await after.send('Runtime.evaluate', {
    expression: `!!document.getElementById('workbuddy-rtl-style') && document.getElementById('fa').getAttribute('dir')`,
    returnByValue: true,
  })
  expect('reload re-applies the layer', message.result?.result?.value, 'rtl')
  try {
    after.socket.close()
  } catch {}
}

let failed = 0
for (const result of results) {
  if (!result.ok) failed++
  console.log(
    `${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}: ${JSON.stringify(result.actual)} (wanted ${JSON.stringify(result.wanted)})`
  )
}
console.log(failed ? `\n${failed} failed` : `\nall ${results.length} passed`)

try {
  socket.close()
} catch {}
chrome.kill()
process.exit(failed ? 1 : 0)
