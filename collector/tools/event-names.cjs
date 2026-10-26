// Names are bound to server actor IDs, never to list position or damage totals.
function validIdentity(row) {
  return row && /^[a-f0-9]{16}$/.test(row.idHash) && typeof row.name === 'string' && row.name.trim() &&
    Buffer.byteLength(row.name, 'utf8') <= 256 && !/[\u0000-\u001f\u007f]/u.test(row.name) && row.nameSource?.startsWith('wire.')
}
function labelEvent(event, identities) {
  const source = identities.get(event.sourceActorHash), target = identities.get(event.targetActorHash)
  return { ...event, sourceActorName: source?.name || null, targetActorName: target?.name || null }
}
module.exports = { validIdentity, labelEvent }
