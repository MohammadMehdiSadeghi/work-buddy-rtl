#!/usr/bin/env node
// Minimal, dependency-free ASAR reader/writer for Electron bundles.
//
// Layout: [u32 pipe-size=4][u32 header-buffer-length][u32 json-length]
//         [header JSON, padded to 4 bytes][payload ...]
// File offsets in the header are relative to the start of the payload.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// The header is a nested Chromium Pickle:
//   u32 4 | u32 (8 + padded JSON) | u32 (4 + padded JSON) | u32 JSON length
//   JSON, padded to 4 bytes | payload ...
// The JSON starts at offset 16; payload offsets are relative to the payload.
export function readHeader(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const fileSize = fs.fstatSync(fd).size
    if (fileSize < 32) throw new Error('not an asar archive (too small)')

    const head = Buffer.alloc(32)
    fs.readSync(fd, head, 0, 32, 0)
    const payloadStart = 8 + head.readUInt32LE(4)
    if (payloadStart < 16 || payloadStart > fileSize) {
      throw new Error('not an asar archive (bad header size)')
    }

    let jsonStart = -1
    for (const candidate of [8, 12, 16]) {
      if (head[candidate] === 0x7b) {
        jsonStart = candidate
        break
      }
    }
    if (jsonStart < 0) throw new Error('not an asar archive (no header JSON)')

    const declared = jsonStart >= 12 ? head.readUInt32LE(jsonStart - 4) : 0
    const length = declared > 0 && jsonStart + declared <= payloadStart ? declared : payloadStart - jsonStart
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, jsonStart)
    const header = JSON.parse(buf.toString('utf8').replace(/\0+$/, ''))
    if (!header || !header.files) throw new Error('not an asar archive (no file tree)')

    return { header, headerSize: payloadStart, payloadStart, jsonStart, jsonLength: length }
  } finally {
    fs.closeSync(fd)
  }
}

export function walk(node, prefix = '', out = []) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, full, out)
    else out.push({ path: full, size: entry.size || 0, offset: entry.offset || 0, unpacked: !!entry.unpacked })
  }
  return out
}

export function findEntry(header, entryPath) {
  let node = header
  for (const part of entryPath.split('/').filter(Boolean)) {
    if (!node.files || !node.files[part]) return null
    node = node.files[part]
  }
  return node.files ? null : node
}

export function readEntry(file, entryPath) {
  const { header, payloadStart } = readHeader(file)
  const entry = findEntry(header, entryPath)
  if (!entry) throw new Error(`entry not found: ${entryPath}`)
  if (entry.unpacked) {
    const unpacked = path.join(`${file}.unpacked`, entryPath)
    if (fs.existsSync(unpacked)) return fs.readFileSync(unpacked)
  }
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(entry.size)
    fs.readSync(fd, buf, 0, entry.size, payloadStart + Number(entry.offset))
    return buf
  } finally {
    fs.closeSync(fd)
  }
}

function ensureDirs(tree, dirPath) {
  let node = tree
  for (const part of dirPath.split('/').filter(Boolean)) {
    if (!node.files[part]) node.files[part] = { files: {} }
    node = node.files[part]
  }
  return node
}

function setFile(tree, entryPath, entry) {
  const parts = entryPath.split('/')
  const name = parts.pop()
  ensureDirs(tree, parts.join('/')).files[name] = entry
}

function removePath(tree, entryPath) {
  const parts = entryPath.split('/')
  const name = parts.pop()
  let node = tree
  for (const part of parts) {
    if (!node.files || !node.files[part]) return
    node = node.files[part]
  }
  if (node.files) delete node.files[name]
}

function copyRange(srcPath, start, length, destFd) {
  const src = fs.openSync(srcPath, 'r')
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
    let pos = start
    let left = length
    while (left > 0) {
      const n = fs.readSync(src, buf, 0, Math.min(buf.length, left), pos)
      if (n <= 0) break
      fs.writeSync(destFd, buf, 0, n)
      pos += n
      left -= n
    }
  } finally {
    fs.closeSync(src)
  }
}

/**
 * Rewrite an asar archive, adding/replacing files without touching the
 * original payload bytes. `replace` keeps the path but swaps its contents.
 */
export function rebuildAsar(file, { add = [], replace = {}, remove = [] } = {}) {
  const { header, payloadStart } = readHeader(file)
  if (header.integrity) {
    throw new Error('asar integrity header present — Electron would reject a modified archive')
  }

  const total = fs.statSync(file).size
  const payloadLength = total - payloadStart
  const tree = JSON.parse(JSON.stringify(header))

  for (const entryPath of remove) removePath(tree, entryPath)

  const items = [
    ...Object.entries(replace).map(([entryPath, data]) => ({ path: entryPath, data })),
    ...add,
  ]

  let cursor = payloadLength
  const blobs = []
  for (const item of items) {
    const pad = (4 - (item.data.length % 4)) % 4
    setFile(tree, item.path, { size: item.data.length, offset: cursor })
    blobs.push(item.data)
    if (pad) blobs.push(Buffer.alloc(pad))
    cursor += item.data.length + pad
  }

  const json = Buffer.from(JSON.stringify(tree), 'utf8')
  const paddedJson = (json.length + 3) & ~3
  const newPayloadStart = 16 + paddedJson
  const prefix = Buffer.alloc(newPayloadStart)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(8 + paddedJson, 4)
  prefix.writeUInt32LE(4 + paddedJson, 8)
  prefix.writeUInt32LE(json.length, 12)
  json.copy(prefix, 16)

  const temp = `${file}.wb-rtl.tmp`
  let dest
  try {
    dest = fs.openSync(temp, 'w')
    fs.writeSync(dest, prefix, 0, prefix.length)
    copyRange(file, payloadStart, payloadLength, dest)
    for (const blob of blobs) fs.writeSync(dest, blob, 0, blob.length)
    fs.fsyncSync(dest)
    fs.closeSync(dest)
    dest = undefined
    fs.renameSync(temp, file)
  } finally {
    if (dest !== undefined) {
      try {
        fs.closeSync(dest)
      } catch {}
    }
    if (fs.existsSync(temp)) {
      try {
        fs.unlinkSync(temp)
      } catch {}
    }
  }

  return { payloadStart: newPayloadStart, appended: cursor - payloadLength }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const [file, cmd = 'list', arg1, arg2] = process.argv.slice(2)
  if (!file) {
    console.error(
      'usage:\n  node tools/asar.mjs <app.asar> list [regex]\n  node tools/asar.mjs <app.asar> read <entry> [out-file]'
    )
    process.exit(2)
  }
  if (cmd === 'read') {
    if (!arg1) {
      console.error('read needs an entry path')
      process.exit(2)
    }
    const data = readEntry(file, arg1)
    if (arg2) {
      fs.mkdirSync(path.dirname(arg2), { recursive: true })
      fs.writeFileSync(arg2, data)
      console.log(`${arg1} -> ${arg2} (${data.length} bytes)`)
    } else {
      process.stdout.write(data)
    }
    process.exit(0)
  }
  const filter = arg1 ? new RegExp(arg1, 'i') : null
  const { header, headerSize } = readHeader(file)
  const entries = walk(header)
  const shown = filter ? entries.filter((e) => filter.test(e.path)) : entries
  for (const e of shown) console.log(`${String(e.size).padStart(10)}  ${e.unpacked ? 'u' : ' '}  ${e.path}`)
  console.log(`\n${shown.length}/${entries.length} entries, header ${headerSize} bytes`)
}
