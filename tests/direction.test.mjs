import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Needs jsdom: npm install && node tests/direction.test.mjs
let JSDOM
try {
  ;({ JSDOM } = await import('jsdom'))
} catch {
  console.log('skip: jsdom is not installed (npm install)')
  process.exit(0)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(HERE, '..', 'patch', 'workbuddy-rtl.js'), 'utf8')

// The markup mirrors the parts of WorkBuddy's DOM the layer touches: the
// sidebar, a markdown bubble with Persian and English text, a code block and
// the composer.
const html = `<!doctype html><html><body>
  <aside class="sk-sidebar"><button class="sk-sidebar-chat">گفتگوی جدید</button></aside>
  <main>
    <div class="cb-chat-message--assistant">
      <div class="cb-chat-message-bubble cb-markdown">
        <p id="fa">سلام، این یک پیام فارسی است.</p>
        <p id="en">This is an English message.</p>
        <p id="appdir" dir="ltr">سلام با dir از خود اپ</p>
        <ul id="list"><li>آیتم اول</li><li>Second item</li></ul>
        <div class="cb-markdown-pre"><pre><code id="code">سلام()</code></pre></div>
      </div>
    </div>
    <textarea id="composer"></textarea>
    <div id="editable" contenteditable="true"></div>
  </main>
</body></html>`

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true })
const { window } = dom
window.eval(source)

const wait = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms))
await wait()

const results = []
const expect = (name, actual, wanted) => results.push({ name, actual, wanted, ok: actual === wanted })
const dir = (id) => window.document.getElementById(id).getAttribute('dir')

expect('persian paragraph', dir('fa'), 'rtl')
expect('english paragraph', dir('en'), null)
expect('app-owned dir is kept', dir('appdir'), 'ltr')
expect('persian list item', window.document.querySelector('#list li').getAttribute('dir'), 'rtl')
expect('english list item', window.document.querySelectorAll('#list li')[1].getAttribute('dir'), null)
expect('code block untouched', dir('code'), null)
expect('sidebar button', window.document.querySelector('.sk-sidebar-chat').getAttribute('dir'), 'rtl')

const composer = window.document.getElementById('composer')
composer.value = 'سلام دنیا'
composer.dispatchEvent(new window.Event('input', { bubbles: true }))
await wait()
expect('composer: persian', composer.getAttribute('dir'), 'rtl')

composer.value = 'hello world'
composer.dispatchEvent(new window.Event('input', { bubbles: true }))
await wait()
expect('composer: english', composer.getAttribute('dir'), 'ltr')

composer.value = ''
composer.dispatchEvent(new window.Event('input', { bubbles: true }))
await wait()
expect('composer: empty', composer.getAttribute('dir'), null)

const editable = window.document.getElementById('editable')
editable.textContent = 'متن فارسی'
await wait()
expect('contenteditable', editable.getAttribute('dir'), 'rtl')

const fa = window.document.getElementById('fa')
fa.textContent = 'Now in English.'
await wait()
expect('direction is dropped when the text turns english', fa.getAttribute('dir'), null)

const fresh = window.document.createElement('p')
fresh.id = 'fresh'
fresh.textContent = 'پیام تازه'
window.document.querySelector('.cb-markdown').appendChild(fresh)
await wait()
expect('message rendered later', dir('fresh'), 'rtl')

window.eval(source)
expect('second injection is a no-op', window.__workbuddyRtl, true)

let failed = 0
for (const result of results) {
  if (!result.ok) failed++
  console.log(
    `${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}: ${JSON.stringify(result.actual)} (wanted ${JSON.stringify(result.wanted)})`
  )
}
console.log(failed ? `\n${failed} failed` : `\nall ${results.length} passed`)
process.exit(failed ? 1 : 0)
