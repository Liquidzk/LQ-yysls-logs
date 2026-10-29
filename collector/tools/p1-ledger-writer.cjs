'use strict'
const fs = require('node:fs'), zlib = require('node:zlib')

// Independent append-only frames: YLZ1, compressed length, decoded length
// (uint32 LE), then zlib data with its checksum. No external compressor.
const MAX_FRAME = 8 * 1024 * 1024
function encodeFrame(raw) {
  if (!raw.length || raw.length > MAX_FRAME) throw Error('Invalid ledger frame size')
  const compressed = zlib.deflateSync(raw, { level: 3 })
  const header = Buffer.alloc(12)
  header.write('YLZ1'); header.writeUInt32LE(compressed.length, 4); header.writeUInt32LE(raw.length, 8)
  return Buffer.concat([header, compressed])
}
function writeAll(fd, bytes) {
  let offset = 0
  while (offset < bytes.length) {
    const count = fs.writeSync(fd, bytes, offset, bytes.length - offset)
    if (!count) throw Error('Unable to write ledger')
    offset += count
  }
}
class LedgerWriter {
  constructor({ interval = 500, blockBytes = 256 * 1024 } = {}) {
    this.files = new Map(); this.blockBytes = blockBytes; this.closed = false
    this.timer = setInterval(() => this.flush(), interval); this.timer.unref()
  }
  append(file, text) {
    if (this.closed) return // child stderr can arrive after shutdown
    const compressed = file.endsWith('.jsonl'), bytes = Buffer.from(text)
    if (compressed && (!text.endsWith('\n') || bytes.length > 4 * 1024 * 1024)) throw Error('Invalid ledger record')
    let r = this.files.get(file)
    if (!r) {
      const target = compressed ? file + '.ylz' : file
      // The collector owns a fresh session; never append past a torn old frame.
      if (compressed && fs.existsSync(file)) throw Error('Legacy ledger already exists')
      r = { fd: fs.openSync(target, 'wx'), compressed, chunks: [], size: 0 }
      this.files.set(file, r)
    }
    if (r.size && r.size + bytes.length > this.blockBytes) this.flushFile(r)
    r.chunks.push(bytes); r.size += bytes.length
    if (r.size >= this.blockBytes) this.flushFile(r)
  }
  flushFile(r) {
    if (!r.size) return
    const raw = Buffer.concat(r.chunks, r.size)
    writeAll(r.fd, r.compressed ? encodeFrame(raw) : raw)
    r.chunks = []; r.size = 0
  }
  flush() { for (const r of this.files.values()) this.flushFile(r) }
  close() {
    if (this.closed) return
    clearInterval(this.timer); this.flush()
    for (const r of this.files.values()) fs.closeSync(r.fd)
    this.files.clear(); this.closed = true
  }
}
module.exports = { LedgerWriter, encodeFrame, MAX_FRAME }
