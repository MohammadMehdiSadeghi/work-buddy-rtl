#!/usr/bin/env node
// Check the patch without starting WorkBuddy.
//
//   node tools/verify.mjs          human readable report
//   node tools/verify.mjs --json   machine readable
//
// Exit code is 0 only when every check passes.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findInstalls } from './locate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PATCH = path.join(REPO, 'patch')

const checks = []
const check = (name, fn) => {
  try {
    const detail = fn()
    checks.push({ name, ok: true, detail: detail || '' })
  } catch (err) {
    checks.push({ name, ok: false, detail: err.message })
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

// ------------------------------------------------------------------ patch ---

const cssFile = path.join(PATCH, 'workbuddy-rtl.css')
const jsFile = path.join(PATCH, 'workbuddy-rtl.js')
const fontFile = path.join(PATCH, 'fonts', 'Vazir-Variable.woff2')

check('patch files exist', () => {
  for (const file of [cssFile, jsFile, fontFile]) {
    assert(fs.existsSync(file), `missing ${path.relative(REPO, file)}`)
  }
  return 'css, js, font'
})

let css = ''
check('stylesheet parses', () => {
  css = fs.readFileSync(cssFile, 'utf8')
  const open = (css.match(/\{/g) || []).length
  const close = (css.match(/\}/g) || []).length
  assert(open === close, `${open} "{" vs ${close} "}"`)
  assert(/src:\s*url\(\s*["']?\.\/fonts\//.test(css), 'font src must stay relative to the patch folder')
  return `${open} rules`
})

check('font is shadowed for Persian only', () => {
  const faces = css.match(/@font-face\s*\{[^}]*\}/g) || []
  const shadowed = faces.filter((face) => /unicode-range/.test(face))
  assert(faces.length > 0, 'no @font-face')
  assert(shadowed.length >= 5, `only ${shadowed.length} families have a unicode-range`)
  for (const face of shadowed) {
    assert(/U\+0600-06FF/.test(face), 'a shadowed family is missing the Arabic range')
  }
  const families = shadowed.map((face) => face.match(/font-family:\s*"([^"]+)"/)[1])
  assert(families.includes('PingFang SC'), 'PingFang SC (the app default) is not shadowed')
  return `${families.length} families`
})

check('no colours are forced', () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
  assert(!/#[0-9a-f]{3,8}\b/i.test(rules), 'a hex colour would break one of the themes')
  assert(!/!important/.test(rules), '!important would fight the app stylesheet')
  return 'font, direction and alignment only'
})

check('code stays left-to-right', () => {
  assert(/direction:\s*ltr/.test(css), 'no LTR island rule')
  assert(/\.cb-markdown-pre/.test(css), 'code block class is missing')
  return 'pre/code/terminal/editor'
})

check('direction script parses', () => {
  new Function(fs.readFileSync(jsFile, 'utf8'))
  const source = fs.readFileSync(jsFile, 'utf8')
  assert(!/\beval\(/.test(source), 'eval() is blocked by CSP in some builds')
  assert(/MutationObserver/.test(source), 'no MutationObserver')
  return 'no eval'
})

check('font file is a woff2', () => {
  const buffer = fs.readFileSync(fontFile)
  assert(buffer.subarray(0, 4).toString('latin1') === 'wOF2', 'bad magic bytes')
  assert(buffer.length > 20 * 1024, 'file looks truncated')
  return `${(buffer.length / 1024).toFixed(1)} KB`
})

// -------------------------------------------------------------------- tools ---

check('tools compile', () => {
  const files = ['launch.mjs', 'inject.mjs', 'locate.mjs', 'asar.mjs', 'verify.mjs'].map((name) => path.join(HERE, name))
  for (const file of files) {
    const out = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert(out.status === 0, `${path.basename(file)}: ${(out.stderr || '').split('\n')[0]}`)
  }
  return `${files.length} files`
})

check('launcher has no dead watcher', () => {
  const source = fs.readFileSync(path.join(HERE, 'launch.mjs'), 'utf8')
  assert(/setInterval\(/.test(source), 'no watcher loop')
  assert(/clearInterval\(/.test(source), 'the watcher is never cleared')
  assert(/addScriptToEvaluateOnNewDocument/.test(fs.readFileSync(path.join(HERE, 'inject.mjs'), 'utf8')), 'reloads would lose the layer')
  return 'injects now and on new windows'
})

// ----------------------------------------------------------------- install ---

check('WorkBuddy install', () => {
  const install = findInstalls()[0]
  assert(install, 'not found on this machine')
  assert(install.version, 'version could not be read from app.asar')
  return `${install.dir} (v${install.version})`
})

// ------------------------------------------------------------------ report ---

const failed = checks.filter((item) => !item.ok)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
} else {
  for (const item of checks) {
    console.log(`${item.ok ? 'ok  ' : 'FAIL'}  ${item.name}${item.detail ? `  — ${item.detail}` : ''}`)
  }
  console.log('')
  console.log(failed.length ? `${failed.length} check(s) failed` : `all ${checks.length} checks passed`)
}

process.exit(failed.length ? 1 : 0)
