/* ==========================================================================
   WorkBuddy RTL — automatic direction detection
   - composer (contenteditable / textarea): direction from the first strong
     character, so a Persian prompt types right-to-left and an English one
     stays left-to-right.
   - short UI text and chat paragraphs that start with Persian get dir="rtl".
   Only the `dir` attribute is written, and only on elements this script owns.
   ========================================================================== */
;(() => {
  'use strict'
  try {
    if (window.__workbuddyRtl) return
    window.__workbuddyRtl = true

    const RTL_CHAR =
      /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/
    const LTR_CHAR =
      /[A-Za-z\u00C0-\u02AF\u0370-\u052F\u1E00-\u1EFF\u2C60-\u2C7F\uA720-\uA7FF]/

    const EDITABLE = '[contenteditable="true"], textarea'
    const SKIP =
      '.composer, .monaco-editor, .cm-editor, .xterm, pre, code, kbd, samp, [contenteditable="true"]'
    const TEXT =
      'p, li, h1, h2, h3, h4, h5, h6, blockquote, dt, dd, td, th, ul, ol, ' +
      'button, label, summary, a, span, div, strong, em, figcaption'

    function dirOf(text) {
      const sample = text.length > 300 ? text.slice(0, 300) : text
      for (const ch of sample) {
        if (RTL_CHAR.test(ch)) return 'rtl'
        if (LTR_CHAR.test(ch)) return 'ltr'
      }
      return null
    }

    function textOf(el) {
      return typeof el.value === 'string' ? el.value : el.textContent || ''
    }

    // Never clobber a direction the app itself set; we only manage ours.
    function applyDir(el, dir) {
      const mine = el.getAttribute('data-wb-rtl') === '1'
      if (!mine && el.hasAttribute('dir')) return
      if (!dir) {
        el.removeAttribute('dir')
        el.removeAttribute('data-wb-rtl')
        return
      }
      if (el.getAttribute('dir') !== dir) el.setAttribute('dir', dir)
      el.setAttribute('data-wb-rtl', '1')
    }

    function markComposer() {
      for (const el of document.querySelectorAll(EDITABLE)) {
        if (el.closest('.monaco-editor, .cm-editor, .xterm')) continue
        const dir = dirOf(textOf(el))
        applyDir(el, dir === 'rtl' ? 'rtl' : dir === 'ltr' ? 'ltr' : null)
      }
    }

    function markText() {
      for (const el of document.querySelectorAll(TEXT)) {
        if (el.isContentEditable) continue
        if (el.children.length && el.tagName !== 'UL' && el.tagName !== 'OL') continue
        if (el.closest(SKIP)) continue
        const text = (el.textContent || '').trim()
        if (!text) continue
        if (dirOf(text) === 'rtl') applyDir(el, 'rtl')
        else if (el.getAttribute('data-wb-rtl') === '1') applyDir(el, null)
      }
    }

    function refresh() {
      markComposer()
      markText()
    }

    let timer = 0
    function schedule() {
      if (timer) return
      timer = setTimeout(() => {
        timer = 0
        try {
          refresh()
        } catch {}
      }, 120)
    }

    document.addEventListener('input', schedule, true)
    document.addEventListener('compositionend', schedule, true)
    document.addEventListener('focusin', schedule, true)
    document.addEventListener('click', schedule, true)

    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', schedule, { once: true })
    } else {
      schedule()
    }
  } catch {}
})()
