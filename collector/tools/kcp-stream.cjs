'use strict'
// Passive KCP segment projection. Does not send ACKs or alter game transport.
function unwrapDatagram(bytes, remote = null) {
  if (bytes.length >= 34 && bytes.readUInt32BE(0) === 0 && ![81, 82, 83, 84].includes(bytes[4])) {
    const endpoint = { address: [...bytes.subarray(4, 8)].join('.'), port: bytes.readUInt16BE(8) }
    if (remote && (endpoint.address !== remote.address || endpoint.port !== remote.port)) throw Error('KCP relay endpoint changed')
    return { body: bytes.subarray(10), endpoint, envelope: 'uu-ipv4' }
  }
  return { body: bytes, endpoint: null, envelope: 'direct' }
}
function segments(bytes) {
  const rows = []; let pos = 0, conversation = null
  while (pos < bytes.length) {
    if (pos + 24 > bytes.length) throw Error('Truncated KCP header')
    const conv = bytes.readUInt32LE(pos), cmd = bytes[pos + 4], length = bytes.readUInt32LE(pos + 20)
    if (![81, 82, 83, 84].includes(cmd) || pos + 24 + length > bytes.length || (cmd !== 81 && length !== 0)) throw Error('Invalid KCP segment')
    if (conversation !== null && conversation !== conv) throw Error('Mixed KCP conversations')
    conversation = conv
    rows.push({ conversation: conv, command: cmd, fragment: bytes[pos + 5], sequence: bytes.readUInt32LE(pos + 12), data: bytes.subarray(pos + 24, pos + 24 + length) })
    pos += 24 + length
  }
  if (!rows.length) throw Error('Empty KCP datagram')
  return rows
}
const relative = (sn, reference) => reference + ((sn - (reference >>> 0)) | 0)
class KcpStream {
  constructor({ conversation, firstSequence, onBytes, gapMs = 3000 }) {
    this.conversation = conversation; this.next = firstSequence; this.onBytes = onBytes; this.gapMs = gapMs
    this.pending = new Map(); this.history = new Map(); this.bytes = 0; this.historyBytes = 0; this.offset = 0; this.gapSince = null
  }
  push(row, metadata = {}, now = Date.now()) {
    if (row.conversation !== this.conversation) throw Error('KCP conversation changed; bind again')
    if (row.command !== 81) return
    const sequence = relative(row.sequence, this.next)
    if (sequence < this.next) {
      const old = this.history.get(sequence)
      if (!old || !old.equals(row.data)) throw Error('Conflicting or unverifiable KCP retransmission')
      return
    }
    const old = this.pending.get(sequence)
    if (old) { if (!old.data.equals(row.data)) throw Error('Conflicting KCP overlap'); return }
    this.pending.set(sequence, { ...row, metadata }); this.bytes += row.data.length
    if (this.bytes > 4 * 1024 * 1024 || this.pending.size > 65536) throw Error('KCP pending buffer exceeds limit')
    while (this.pending.has(this.next)) {
      const item = this.pending.get(this.next); this.pending.delete(this.next); this.bytes -= item.data.length
      this.history.set(this.next, item.data); this.historyBytes += item.data.length; this.next++
      while (this.historyBytes > 4 * 1024 * 1024 || this.history.size > 65536) {
        const first = this.history.keys().next().value; this.historyBytes -= this.history.get(first).length; this.history.delete(first)
      }
      this.onBytes(item.data, { ...item.metadata, seq: this.offset }); this.offset += item.data.length
    }
    this.gapSince = this.pending.size ? this.gapSince ?? now : null
  }
  tick(now = Date.now()) { if (this.gapSince !== null && now - this.gapSince >= this.gapMs) throw Error('Unresolved KCP gap; continuity invalid') }
}
function parseRow(line, remote = null) {
  const a = line.replace(/^\uFEFF/, '').split('\t')
  if (a.length !== 8) throw Error('Invalid UDP capture row')
  const hex = a[7].replace(/:/g, '')
  if (!/^(?:[\da-f]{2})+$/i.test(hex)) throw Error('Missing UDP payload')
  const packet = unwrapDatagram(Buffer.from(hex, 'hex'), remote)
  return { frame: +a[0], time: +a[1], iface: +a[2], src: a[3], sport: +a[4], dst: a[5], dport: +a[6],
    ...packet, segments: segments(packet.body) }
}
function assemble(packets) {
  const pushes = packets.flatMap(p => p.segments.filter(s => s.command === 81).map(s => ({ ...s, time: p.time })))
  if (!pushes.length) throw Error('No KCP stream data')
  const reference = pushes[0].sequence
  pushes.sort((a, b) => relative(a.sequence, reference) - relative(b.sequence, reference))
  const unique = new Map()
  for (const p of pushes) {
    const sn = relative(p.sequence, reference), old = unique.get(sn)
    if (old && !old.data.equals(p.data)) throw Error('Conflicting KCP retransmission')
    if (!old) unique.set(sn, p)
  }
  const rows = [...unique.values()]; let end = 0, last = null
  for (const row of rows) {
    const sn = relative(row.sequence, reference)
    if (last !== null && sn !== last + 1) throw Error('KCP gap in initialization')
    last = sn; end += row.data.length; row.end = end
  }
  return { cipher: Buffer.concat(rows.map(r => r.data)), rows, firstSequence: rows[0].sequence, conversation: rows[0].conversation }
}
module.exports = { unwrapDatagram, segments, KcpStream, parseRow, assemble }
