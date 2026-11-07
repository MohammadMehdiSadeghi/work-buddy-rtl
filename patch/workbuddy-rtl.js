/* ==========================================================================
   WorkBuddy RTL — automatic direction detection
   - a whole markdown block (one chat message) takes one direction, decided by
     the majority of its letters, so a Persian message stays right-to-left even
     when a paragraph inside it starts with a Latin word.
   - the composer (contenteditable / textarea) takes its direction from the
     first strong character, so a Persian prompt types right-to-left and an
     English one stays left-to-right.
   - short app labels (sidebar, buttons, settings) are marked individually.
   Only the `dir` attribute is written, and only on elements this script owns
   (`data-wb-rtl="1"`); a direction set by the app itself is never touched.
   ========================================================================== */
;(() => {
  'use strict'
  try {
    if (window.__workbuddyRtl) return

    const RTL_CHAR =
      /[\u0590-\u05FF\u0600-\u06FF\u0700-\u07BF\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/
    const LTR_CHAR =
      /[A-Za-z\u00C0-\u02AF\u0370-\u052F\u1E00-\u1EFF\u2C60-\u2C7F\uA720-\uA7FF\uFF21-\uFF3A\uFF41-\uFF5A]/

    const EDITABLE = 'textarea, [contenteditable="true"], [contenteditable=""]'
    const CODE =
      'pre, code, kbd, samp, .cb-markdown-pre, .cr-code-block, .monaco-editor, .cm-editor, .xterm'

    // Never inside code, an editor or the composer itself.
    const SKIP = `${CODE}, ${EDITABLE}`

    // A prose container: everything inside it shares one direction.
    const SCOPE = '.cb-markdown, [class*="markdown"], .markdown-preview__body'

    const rtlCache = new WeakMap()

    function dirOf(text) {
      const sample = text.length > 300 ? text.slice(0, 300) : text
      for (const ch of sample) {
        if (RTL_CHAR.test(ch)) return 'rtl'
        if (LTR_CHAR.test(ch)) return 'ltr'
      }
      return null
    }

    // Majority of letters, not the first one: a Persian message with English
    // terms in it is still Persian. `plaintext` used to do this per line, which
    // made any line starting with a Latin word jump to the left edge.
    function dirOfBlock(text) {
      let rtl = 0
      let ltr = 0
      const sample = text.length > 4000 ? text.slice(0, 4000) : text
      for (const ch of sample) {
        if (RTL_CHAR.test(ch)) rtl++
        else if (LTR_CHAR.test(ch)) ltr++
      }
      if (!rtl && !ltr) return null
      if (!ltr) return 'rtl'
      if (!rtl) return 'ltr'
      // A third of the letters is enough to call a block Persian.
      return rtl * 2 >= ltr ? 'rtl' : 'ltr'
    }

    function textOf(el) {
      // Only form fields have a meaningful .value; a <button> or an <li> also
      // exposes one (usually empty), and reading it would hide their text.
      const tag = el.tagName
      if ((tag === 'TEXTAREA' || tag === 'INPUT') && typeof el.value === 'string') return el.value
      return el.textContent || ''
    }

    // Only manage directions this script set, never one the app set itself.
    function applyDir(el, dir) {
      if (!el || el.nodeType !== 1) return
      if (el === document.documentElement || el === document.body) return
      const mine = el.getAttribute('data-wb-rtl') === '1'
      if (!mine && el.hasAttribute('dir')) return
      if (!dir) {
        if (mine) {
          el.removeAttribute('dir')
          el.removeAttribute('data-wb-rtl')
        }
        return
      }
      if (el.getAttribute('dir') !== dir) el.setAttribute('dir', dir)
      if (!mine) el.setAttribute('data-wb-rtl', '1')
    }

    function markComposers(root) {
      for (const el of root.querySelectorAll(EDITABLE)) {
        if (el.closest('.monaco-editor, .cm-editor, .xterm')) continue
        applyDir(el, dirOf(textOf(el)))
      }
    }

    function blockDir(scope) {
      const text = scope.textContent || ''
      const head = text.slice(0, 64)
      const cached = rtlCache.get(scope)
      if (cached && cached.head === head && cached.length === text.length) return cached.dir
      const dir = dirOfBlock(text)
      rtlCache.set(scope, { head, length: text.length, dir })
      return dir
    }

    function markScopes() {
      for (const scope of document.querySelectorAll(SCOPE)) {
        if (scope.closest(SKIP)) continue
        // Only ever add rtl: an English block keeps the app's own default, so
        // the attribute does not flip back and forth on every pass.
        applyDir(scope, blockDir(scope) === 'rtl' ? 'rtl' : null)
      }
    }

    // One pass over the text nodes: much cheaper than querying every tag name,
    // and it reaches text inside components this script knows nothing about.
    function markText(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
          const parent = node.parentElement
          if (!parent) return NodeFilter.FILTER_REJECT
          if (parent.closest(SKIP)) return NodeFilter.FILTER_REJECT
          // Inside a prose container the direction comes from the container.
          if (parent.closest(SCOPE)) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      let node = walker.nextNode()
      while (node) {
        if (dirOf(node.nodeValue) === 'rtl') applyDir(node.parentElement, 'rtl')
        node = walker.nextNode()
      }
    }

    // Clearing is a separate, rare pass: an element that was Persian can turn
    // English after a re-render, but a mixed element must not lose its rtl.
    function clearStale() {
      for (const el of document.querySelectorAll('[data-wb-rtl="1"]')) {
        if (el.matches(EDITABLE)) continue
        if (el.closest(SKIP)) {
          applyDir(el, null)
          continue
        }
        const wanted = el.matches(SCOPE) ? blockDir(el) : dirOf(textOf(el)) === 'rtl' ? 'rtl' : null
        if (wanted !== 'rtl') applyDir(el, null)
      }
    }

    function refresh(root) {
      const scope = root && root.nodeType === 1 ? root : document.body
      if (!scope) return
      markComposers(document)
      markScopes()
      markText(scope)
      if (scope === document.body) clearStale()
    }

    let timer = 0
    function schedule() {
      if (timer) return
      timer = setTimeout(() => {
        timer = 0
        try {
          refresh(document.body)
        } catch {}
      }, 120)
    }

    function boot() {
      if (!document.body) return false
      try {
        new MutationObserver(schedule).observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        })
      } catch {
        return false
      }
      document.addEventListener('input', schedule, true)
      document.addEventListener('compositionend', schedule, true)
      document.addEventListener('focusin', schedule, true)
      document.addEventListener('click', schedule, true)
      window.__workbuddyRtl = true
      window.__workbuddyRtlRefresh = () => {
        try {
          refresh(document.body)
        } catch {}
      }
      refresh(document.body)
      return true
    }

    // Page.addScriptToEvaluateOnNewDocument runs before <body> exists, so the
    // first attempt usually fails; DOMContentLoaded is the real entry point.
    if (!boot()) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true })
      } else {
        let tries = 0
        const retry = () => {
          if (boot() || ++tries > 40) return
          requestAnimationFrame(retry)
        }
        retry()
      }
    }
  } catch {}
})()
