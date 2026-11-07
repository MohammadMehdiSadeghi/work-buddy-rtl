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

// The markup mirrors the parts of WorkBuddy's DOM the layer touches: a sidebar
// label, three markdown messages (Persian, English, mixed), a code block and
// the composer.
const html = `<!doctype html><html><body>
  <aside class="sk-sidebar"><button class="sk-sidebar-chat">گفتگوی جدید</button></aside>
  <main>
    <div class="cb-chat-message--assistant">
      <div class="cb-chat-message-bubble cb-markdown" id="fa-block">
        <p id="fa">سلام، این یک پیام فارسی است.</p>
        <p id="appdir" dir="ltr">سلام با dir از خود اپ</p>
        <ul><li id="li1">آیتم اول</li></ul>
        <div class="cb-markdown-pre"><pre><code id="code">سلام()</code></pre></div>
      </div>
      <div class="cb-chat-message-bubble cb-markdown" id="en-block">
        <p id="en">This is an English message.</p>
      </div>
      <div class="cb-chat-message-bubble cb-markdown" id="mixed-block">
        <p id="mixed">ممنون، الگو ساده است:<br>line-height 1.35 و (text-editor، 16px) ادامه دارد<br>خط سوم هم فارسی است.</p>
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
const attr = (id, name) => window.document.getElementById(id).getAttribute(name)

expect('persian block direction', attr('fa-block', 'dir'), 'rtl')
expect('persian paragraph inherits, no own dir', attr('fa', 'dir'), null)
expect('english block stays untouched', attr('en-block', 'dir'), null)
expect('mixed block is still persian', attr('mixed-block', 'dir'), 'rtl')
expect('app-owned dir is kept', attr('appdir', 'dir'), 'ltr')
expect('code block untouched', attr('code', 'dir'), null)
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

// An English message that becomes Persian, and a Persian one that becomes
// English: the block follows its content.
const enBlock = window.document.getElementById('en-block')
window.document.getElementById('en').textContent = 'این حالا فارسی است.'
await wait()
expect('english block turns persian', enBlock.getAttribute('dir'), 'rtl')

const faBlock = window.document.getElementById('fa-block')
for (const p of faBlock.querySelectorAll('p, li')) p.textContent = 'Now English.'
await wait()
expect('persian block turns english', faBlock.getAttribute('dir'), null)

// A message rendered after load gets its own direction.
const fresh = window.document.createElement('div')
fresh.className = 'cb-chat-message-bubble cb-markdown'
fresh.id = 'fresh-block'
fresh.innerHTML = '<p>پیام تازه</p>'
window.document.querySelector('main').appendChild(fresh)
await wait()
expect('message rendered later', attr('fresh-block', 'dir'), 'rtl')

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
