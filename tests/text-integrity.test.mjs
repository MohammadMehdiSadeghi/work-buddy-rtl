import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connectTarget, cssSource, inject, isTarget, listTargets, loadPatch } from '../tools/inject.mjs'
import { findBrowser } from './browser-path.mjs'

// The layer must be purely visual: it may add a `dir` attribute, and nothing
// else. This test snapshots the message before and after injection and fails
// if a single character, space or control mark changed.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DIR = path.join(os.tmpdir(), 'workbuddy-rtl-integrity')

const browser = findBrowser()
if (!browser) {
  console.log('skip: no Chrome or Edge found')
  process.exit(0)
}

fs.mkdirSync(path.join(DIR, 'renderer'), { recursive: true })
fs.writeFileSync(
  path.join(DIR, 'renderer', 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <div class="cb-chat-message--assistant"><div class="cb-chat-message-bubble cb-markdown" id="md">
    <p>ممنون — الگو ساده است: <code>line-height 1.35</code> و <strong>FontAwesome</strong> (سمت چپ).</p>
    <p>Hello world.</p>
    <ul><li>آیتم اول</li><li>Second item</li></ul>
    <pre class="cb-markdown-pre"><code>const a = 1; // سلام</code></pre>
  </div></div>
</body></html>`
)

const PORT = 9911 + Math.floor(Math.random() * 300)
const chrome = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${path.join(DIR, 'profile')}`,
    `--remote-debugging-port=${PORT}`,
    `file:///${path.join(DIR, 'renderer', 'index.html').replace(/\\/g, '/')}`,
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

const session = await connectTarget(target)
const evaluate = async (expression) => {
  const message = await session.send('Runtime.evaluate', { expression, returnByValue: true })
  return message.result?.result?.value
}

const snapshot = () =>
  evaluate(`(() => {
    const el = document.getElementById('md')
    return { text: el.textContent, inner: el.innerText, html: el.innerHTML, dir: el.getAttribute('dir') }
  })()`)

const before = await snapshot()
const { css, js } = loadPatch(path.join(ROOT, 'patch'))
await inject(target, { css: cssSource(css), js })
await sleep(900)
const after = await snapshot()

const marks = (text) => (text.match(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g) || []).length
const stripDir = (html) => html.replace(/\s*dir="(rtl|ltr)"/g, '').replace(/\s*data-wb-rtl="1"/g, '')

const results = []
const expect = (name, actual, wanted) => results.push({ name, actual, wanted, ok: actual === wanted })

expect('the message is recognised as persian', after.dir, 'rtl')
expect('textContent is identical', after.text, before.text)
expect('innerText is identical', after.inner, before.inner)
expect('html only gained the dir attribute', stripDir(after.html), stripDir(before.html))
expect('no bidi control characters were inserted', marks(after.text), marks(before.text))

let failed = 0
for (const result of results) {
  const same = result.name.includes('textContent') || result.name.includes('innerText') || result.name.includes('html') || result.name.includes('characters')
  const ok = result.ok
  if (!ok) failed++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${result.name}${same && ok ? '' : `: ${JSON.stringify(result.actual)} (wanted ${JSON.stringify(result.wanted)})`}`
  )
}
console.log(failed ? `\n${failed} failed` : '\nthe layer is purely visual — no character was touched')

try {
  session.socket.close()
} catch {}
chrome.kill()
process.exit(failed ? 1 : 0)
