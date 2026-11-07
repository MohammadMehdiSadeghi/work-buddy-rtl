# WorkBuddy RTL — Technical notes

Implementation details for the Persian (RTL) layer of the WorkBuddy desktop app
(WorkBuddy 5.9.4, Electron).

## 1. Why app.asar cannot be patched

WorkBuddy's renderer lives inside a 182 MB `resources/app.asar`, so the typical
"add files and link them from index.html" approach means rewriting that archive.

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

`tools/launch.mjs`:

1. finds the install (`tools/locate.mjs`) and the `WorkBuddyAI.exe` executable,
2. starts it with `--remote-debugging-port=<random high port>
   --remote-debugging-address=127.0.0.1`,
3. polls `http://127.0.0.1:<port>/json/list` until a `page` target whose URL
   contains `app.asar/renderer/index.html` appears,
4. for every such target: `Page.enable`,
   `Page.addScriptToEvaluateOnNewDocument(bootstrap)` and an immediate
   `Runtime.evaluate(bootstrap)` so the current document is styled too,
5. keeps the CDP sessions open, polls the target list every two seconds and
   injects into new windows (settings, conversations, …) until the app exits.

Because the sessions stay open, a reload of any window re-runs the bootstrap via
the `addScriptToEvaluateOnNewDocument` registration.

## 3. Bootstrap payload

The bootstrap is one self-contained IIFE carrying two string literals:

- the stylesheet, with each `url("./fonts/Vazir-*.woff2")` replaced by a
  base64 `data:font/woff2` URI (about 175 KB total),
- the direction script.

On every document it creates `<style id="workbuddy-rtl-style">` in `<head>` and
runs the script once (`window.__workbuddyRtl` guard). Everything is wrapped in
`try/catch`, so a CDP or DOM failure cannot break the app.

## 4. Font strategy

The app ships *Assistant* (Latin), *Source Code Pro* (code) and font stacks
based on `PingFang SC` / `Segoe UI` / `Microsoft YaHei` — none is a good Persian
face. The patch declares `@font-face` rules for **those same family names**,
limited to the Arabic/Persian `unicode-range`:

```
U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0898-08E1,
U+08E3-08FF, U+FB50-FDFF, U+FE70-FEFF
```

Latin, Cyrillic and CJK glyphs keep the app's fonts; only Persian resolves to
Vazir. The variable font covers every weight from thin to black, so body text,
labels and headings keep the weight the app asked for. There is no global
`font-family !important`, which would also replace icon fonts and the monospace
stack.

## 5. Direction

`workbuddy-rtl.js`:

- computes the composer's direction (`[contenteditable="true"]`, `textarea`)
  from the **first strong character** on input, composition, focus and click;
  empty keeps the app's placeholder direction,
- walks text-bearing leaf elements and sets `dir="rtl"` when the text starts
  with a strong RTL character, skipping code, terminals, editors, the composer
  and anything inside them,
- only ever manages its own `dir` attributes (`data-wb-rtl="1"`), never the
  app's,
- coalesces work with a 120 ms timer behind a `MutationObserver`.

The CSS turns `[dir="rtl"]` into right alignment, mirrors list and blockquote
indentation, and gives markdown paragraphs `unicode-bidi: plaintext` so mixed
English/Persian sentences read in the right order.

## 6. Limitations

- Content inside a webview/iframe or a shadow root is not reached by page-level
  CSS.
- The first paint may be un-styled for a fraction of a second, until the
  launcher connects and injects.
- WorkBuddy must be started by the launcher; starting the `.exe` directly gives
  the stock English/Chinese UI (and no debug port).
- If WorkBuddy changes its renderer URL or drops DevTools support, the launcher
  needs updating.
