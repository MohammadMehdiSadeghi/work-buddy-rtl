# WorkBuddy RTL — Technical notes

Implementation details for the Persian (RTL) layer of the WorkBuddy desktop app
(verified against WorkBuddy 5.9.4 on Windows 11).

## 1. Why app.asar cannot be patched

WorkBuddy's renderer lives inside a ~182 MB `resources/app.asar`, so the usual
"add files next to the app and link them from `index.html`" approach means
rewriting that archive.

That was tried first and fails: the app is built with Electron's **ASAR
integrity validation** fuse enabled. On startup Electron hashes `app.asar` and
compares it with a hash embedded in the executable; a modified archive aborts
the app:

```
FATAL:electron\shell\common\asar\asar_util.cc:143
Integrity check failed for asar archive (45aba4… vs 7dedfd…)
```

The expected hash is not in the archive header (which only has `files`) and not
in `resources/` as a text file — it is baked into the 204 MB executable. So
there is no supported way to modify the archive without disabling a security
feature, which this project deliberately does not do.

## 2. Injection architecture

`tools/launch.mjs` (process lifecycle) and `tools/inject.mjs` (CDP plumbing):

1. finds the install (`tools/locate.mjs`, which reads `package.json` out of the
   archive with `tools/asar.mjs`) and the `WorkBuddyAI.exe` executable,
2. refuses to start when WorkBuddy is already running — the app takes a
   single-instance lock, so a second copy would exit and leave no renderer to
   inject into. `--restart` closes the running instance first (by pid, via
   `tasklist`/`taskkill`, never by image name),
3. starts the app with `--remote-debugging-port=<random high port>
   --remote-debugging-address=127.0.0.1`,
4. polls `http://127.0.0.1:<port>/json/list` until a `page` target whose URL
   contains `app.asar/renderer/index.html` appears,
5. for every such target: `Page.enable`, two
   `Page.addScriptToEvaluateOnNewDocument` registrations (stylesheet, direction
   script) plus two immediate `Runtime.evaluate` calls so the current document
   is styled as well,
6. keeps the CDP sessions open, polls the target list every 1.5 s and injects
   into new windows (settings, conversations, …) until the app exits,
7. writes `%TEMP%/workbuddy-rtl.json` (`pid`, `port`, `startedAt`) so
   `--status` can tell whether the running app is a *launched* one, and removes
   it on exit.

Because the sessions stay open, a reload of any window re-runs both scripts
through the `addScriptToEvaluateOnNewDocument` registration.

## 3. Bootstrap payload

Each concern is its own self-contained IIFE, and neither uses `eval`:

- **stylesheet** — a string literal with every `url("./fonts/Vazir-*.woff2")`
  replaced by a base64 `data:font/woff2` URI (about 175 KB total). On every
  document it creates `<style id="workbuddy-rtl-style">` in `<head>`, retries
  after `DOMContentLoaded` when `<head>` does not exist yet, and replaces the
  text only when it changed.
- **direction script** — the guarded IIFE from `patch/workbuddy-rtl.js`.

`eval` is avoided on purpose: a renderer with a Content-Security-Policy that
lacks `'unsafe-eval'` would break an eval-based bootstrap silently, and the
failure would look like "the patch does nothing". CDP-injected scripts are not
subject to page CSP, but a `<style>` element is — WorkBuddy 5.9.4 ships no CSP
on its main renderer (checked in `renderer/index.html` and the main bundle), so
a plain `<style>` is enough here.

## 4. Font strategy

The app ships *Assistant* (Latin) and *Source Code Pro* (code) and builds its
stacks around `PingFang SC` / `Segoe UI` / `Microsoft YaHei` / `Inter` — none is
a good Persian face. The patch declares `@font-face` rules for **those same
family names**, limited to the Arabic/Persian `unicode-range`:

```
U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0898-08E1,
U+08E3-08FF, U+FB50-FDFF, U+FE70-FEFF
```

Latin, Cyrillic and CJK glyphs keep the app's fonts; only Persian resolves to
Vazir. The variable font covers every weight from thin to black, so body text,
labels and headings keep the weight the app asked for. There is no global
`font-family: … !important`, which would also replace icon fonts and the
monospace stack.

Families shadowed: `PingFang SC` (first in almost every app stack), `Segoe UI`,
`Microsoft YaHei`, `Hiragino Sans GB`, `Inter`, `Assistant`, `SF Pro Text`,
`Helvetica Neue`.

## 5. Direction

`patch/workbuddy-rtl.js`:

- computes the composer's direction (`textarea`, `[contenteditable]`) from the
  **first strong character** on input, composition, focus and click; empty
  input clears the attribute so the app's placeholder keeps its own direction,
- gives a whole prose container (`.cb-markdown`, `[class*="markdown"]`,
  `.markdown-preview__body`) **one** direction, decided by the majority of its
  letters — a third of Persian letters is enough to call a block Persian. The
  direction is written on the container, and every paragraph, list and table
  inside it inherits,
- marks short app labels (sidebar items, buttons, settings rows) individually,
  from their first strong character,
- walks text nodes with a `TreeWalker` and skips anything inside a prose
  container (the container already decided), code, terminals, editors and the
  composer,
- only ever manages its own `dir` attributes (`data-wb-rtl="1"`); a direction
  the app set itself is never touched,
- coalesces work with a 120 ms timer behind a `MutationObserver` on `<body>`,
- clears the attribute in a separate, rarer pass, so an element that was
  Persian and became English does not keep a stale direction.

Three details that caused real bugs and are worth keeping in mind:

- **`unicode-bidi: plaintext` is a trap here.** It decides the base direction
  per *bidi paragraph*, and every `<br>` starts a new one. A Persian paragraph
  whose second line began with `line-height` or `(text-editor` flipped that
  line to the left edge — the "half a line jumps left" report. It is gone; the
  direction now comes from the container's `dir` attribute, and embedded
  English runs stay left-to-right on their own through the bidi algorithm.
  `tests/app-css.test.mjs` measures the left offset of every line of such a
  paragraph and fails if any of them reaches the left margin.
- **`.value` is not text.** A `<button>`, `<li>` or `<option>` exposes an empty
  `.value`; reading it instead of `textContent` made every Persian sidebar
  label look empty. Only `textarea` and `input` use `.value`.
- **Specificity of alignment.** A blanket `[dir="rtl"] { text-align: right }`
  also overrode the centring the app applies to its buttons. Alignment is now
  declared only for block text (`p, li, h1…h6, blockquote, dt, dd, td, th`)
  with the same specificity as a `.class p` rule, so it wins by being injected
  last and nothing else moves.

The stylesheet forces `direction: ltr` and `unicode-bidi: isolate` on code,
terminal and editor islands, so a snippet inside a Persian answer is never
reordered and never leaks its direction into the surrounding sentence.

No colour is ever set: every surface, border and background keeps the app's
theme tokens, so light and dark themes both look correct.

## 6. Tests

| Command | What it checks |
| --- | --- |
| `node tools/verify.mjs` | patch files, CSS/JS syntax, font file, tool syntax, install detection |
| `node tests/direction.test.mjs` | the direction script against a jsdom fixture (needs `npm install`) |
| `node tests/browser.test.mjs` | the whole CDP path in headless Chrome/Edge: stylesheet applied, font resolved, reload re-applied |
| `node tests/app-css.test.mjs` | the same, but on top of every `.css` inside the installed `app.asar` — proves the patch wins against the app's real specificity |
| `node tests/text-integrity.test.mjs` | snapshots a message before and after injection: text, innerText and HTML must be identical apart from the added `dir` attribute |

`tests/browser.test.mjs` and `tests/app-css.test.mjs` use the same
`tools/inject.mjs` calls the launcher makes, so a green run means the injection
path works in a real Chromium. The second one is the important one: it loads
the app's own 154 stylesheets (about 9 MB on 5.9.4) into the page, so a rule
that loses a specificity fight shows up as a failure instead of as "the patch
does nothing on my machine". Both skip themselves when WorkBuddy or a browser
is missing.

## 7. Limitations

- Content inside a webview/iframe or a shadow root is not reached by page-level
  CSS.
- The first paint may be un-styled for a fraction of a second, until the
  launcher connects and injects.
- WorkBuddy must be started by the launcher; starting the `.exe` directly gives
  the stock UI (and no debug port). An update does not remove the layer — it
  lives outside the app — but a launcher started before the update keeps
  injecting the patch it read at startup, so restart it after an update.
- If WorkBuddy changes its renderer URL or drops DevTools support, the launcher
  needs updating. `--status` reports the detected install and version so the
  cause is visible.
- The layer changes font, direction and alignment only. It does not translate
  the app's interface.
