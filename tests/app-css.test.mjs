import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readHeader, walk, readEntry } from '../tools/asar.mjs'
import { findInstalls } from '../tools/locate.mjs'
import { connectTarget, cssSource, inject, isTarget, listTargets, loadPatch } from '../tools/inject.mjs'
import { findBrowser } from './browser-path.mjs'

// The strongest check available without starting WorkBuddy: load the app's own
// stylesheets (every .css inside app.asar) into a Chromium page, inject the
// patch exactly like the launcher does, and confirm the result survives the
// app's real specificity and font stacks. Skips itself when WorkBuddy or a
// browser is missing.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const install = findInstalls()[0]
const browser = findBrowser()
if (!install || !browser) {
  console.log(`skip: ${!install ? 'WorkBuddy is not installed' : 'no Chrome or Edge found'}`)
  process.exit(0)
}

const WORK = path.join(os.tmpdir(), 'workbuddy-rtl-app-css')
const PAGE = path.join(WORK, 'renderer')
fs.mkdirSync(PAGE, { recursive: true })

const { header } = readHeader(install.asar)
const sheets = walk(header)
  .filter((entry) => /\.css$/i.test(entry.path))
  .sort((a, b) => a.path.localeCompare(b.path))

let bundle = ''
for (const sheet of sheets) {
  try {
    bundle += `\n/* ${sheet.path} */\n${readEntry(install.asar, sheet.path).toString('utf8')}`
  } catch {}
}
fs.writeFileSync(path.join(PAGE, 'app.css'), bundle)
console.log(`app stylesheets: ${sheets.length} files, ${(bundle.length / 1024 / 1024).toFixed(1)} MB`)

fs.writeFileSync(
  path.join(PAGE, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="app.css"></head>
<body class="vscode-dark">
  <aside class="sk-sidebar"><button class="sk-sidebar-btn" id="side">گفتگوی جدید</button></aside>
  <div class="cb-chat-message--assistant">
    <div class="cb-chat-message-bubble cb-markdown">
      <p id="fa">سلام، این یک پیام فارسی است.</p>
      <p id="en">This is an English message.</p>
      <ul><li id="li1">آیتم اول</li><li id="li2">Second item</li></ul>
      <div class="cb-markdown-pre"><pre id="pre"><code id="code">console.log("سلام")</code></pre></div>
    </div>
  </div>
  <textarea id="composer"></textarea>
</body></html>`
)

const PORT = 9622 + Math.floor(Math.random() * 300)
const chrome = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${path.join(WORK, 'profile')}`,
    `--remote-debugging-port=${PORT}`,
    `file:///${path.join(PAGE, 'index.html').replace(/\\/g, '/')}`,
  ],
  { stdio: 'ignore' }
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let target = null
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250)
  target = (await listTargets(PORT)).filter(isTarget)[0]
}
if (!target) {
  console.log('FAIL  the browser never loaded the fixture')
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
await sleep(800)

const results = []
const expect = (name, actual, wanted) => results.push({ name, actual, wanted, ok: actual === wanted })

expect('persian paragraph alignment', await evaluate(`getComputedStyle(document.getElementById('fa')).textAlign`), 'right')
expect('persian paragraph dir', await evaluate(`document.getElementById('fa').getAttribute('dir')`), 'rtl')
expect('english paragraph untouched', await evaluate(`document.getElementById('en').getAttribute('dir')`), null)
expect('persian list item', await evaluate(`document.getElementById('li1').getAttribute('dir')`), 'rtl')
expect('code direction', await evaluate(`getComputedStyle(document.getElementById('code')).direction`), 'ltr')
expect('code block direction', await evaluate(`getComputedStyle(document.getElementById('pre')).direction`), 'ltr')
expect('sidebar label', await evaluate(`document.getElementById('side').getAttribute('dir')`), 'rtl')
expect('sidebar keeps its centring', await evaluate(`getComputedStyle(document.getElementById('side')).textAlign`), 'center')
expect(
  'the app font stack resolves to Vazir',
  await evaluate(`(async () => {
    await document.fonts.ready
    const measure = (family) => {
      const el = document.createElement('span')
      el.style.cssText = 'position:absolute;visibility:hidden;font-size:32px;font-family:' + family
      el.textContent = 'سلام دنیا'
      document.body.appendChild(el)
      const width = el.getBoundingClientRect().width
      el.remove()
      return width
    }
    return Math.abs(measure(getComputedStyle(document.getElementById('fa')).fontFamily) - measure('system-ui')) > 1
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
