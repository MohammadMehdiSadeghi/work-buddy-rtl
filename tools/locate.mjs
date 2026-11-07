#!/usr/bin/env node
// Find WorkBuddy installs and report their version.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readEntry } from './asar.mjs'

const home = os.homedir()
const env = process.env

function versionOf(asar) {
  try {
    const pkg = JSON.parse(readEntry(asar, 'package.json').toString('utf8'))
    return pkg.version || ''
  } catch {
    return ''
  }
}

const filterText = /app\.asar\/renderer\/index\.html/i

export function findInstalls() {
  const found = []
  const add = (dir) => {
    if (!dir) return
    const candidates = [path.join(dir, 'resources', 'app.asar'), path.join(dir, 'app.asar')]
    const asar = candidates.find((p) => fs.existsSync(p))
    if (!asar) return
    if (found.some((f) => f.asar === asar)) return
    found.push({ dir, asar, version: versionOf(asar), targetSelector: filterText })
  }

  const readDirs = (base, depth = 2) => {
    if (!base || depth < 0) return []
    let entries = []
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(base, entry.name)
      out.push(full, ...readDirs(full, depth - 1))
    }
    return out
  }

  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    const programs = path.join(local, 'Programs')
    for (const name of ['WorkBuddyAI', 'WorkBuddy', 'workbuddy', '@genieworkbuddy-desktop']) {
      add(path.join(programs, name))
      add(path.join(env.ProgramFiles || 'C:\\Program Files', name))
      add(path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', name))
    }
    for (const dir of readDirs(programs, 1)) {
      if (/workbuddy|work-buddy/i.test(path.basename(dir))) add(dir)
    }
  } else if (process.platform === 'darwin') {
    for (const base of ['/Applications', path.join(home, 'Applications')]) {
      for (const name of ['WorkBuddy.app', 'WorkBuddyAI.app']) {
        add(path.join(base, name, 'Contents', 'Resources'))
      }
      try {
        for (const entry of fs.readdirSync(base)) {
          if (/workbuddy.*\.app$/i.test(entry)) add(path.join(base, entry, 'Contents', 'Resources'))
        }
      } catch {}
    }
  } else {
    for (const base of ['/opt', path.join(home, '.local', 'opt')]) {
      for (const name of ['WorkBuddy', 'WorkBuddyAI', 'workbuddy']) {
        add(path.join(base, name, 'resources'))
        add(path.join(base, name))
      }
    }
  }

  return found
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const installs = findInstalls()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(installs, null, 2))
  } else if (installs.length === 0) {
    console.log('No WorkBuddy install found.')
  } else {
    for (const install of installs) {
      console.log(`${install.dir}${install.version ? `  (v${install.version})` : ''}`)
    }
  }
}
