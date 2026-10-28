const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path')
const { execFileSync } = require('node:child_process')
const discover = scenario => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  path.join(__dirname, 'discover-fixture.ps1'), '-DiscoveryScript', path.join(__dirname, '../collector/tools/p2-discover.ps1'), '-Scenario', scenario],
{ encoding: 'utf8', windowsHide: true, timeout: 10000 }).replace(/^\uFEFF/, ''))
const options = { skip: process.platform !== 'win32' }
test('UDP-only game connection exposes only the selected process endpoints', options, () => {
  const d = discover('kcp'); assert.equal(d.status, 'running'); assert.deepEqual(d.flows, [])
  assert.deepEqual(d.udpEndpoints, [{ clientAddress: '0.0.0.0', clientPort: 62613 }]); assert.equal(d.interfaces.length, 1)
})
test('accelerator loopback connections stay bound to the chosen game and select Npcap loopback', options, () => {
  const d = discover('loopback'); assert.equal(d.status, 'running'); assert.equal(d.pid, 77)
  assert.deepEqual(d.flows.map(f => f.serverPort), [1111, 443]); assert.equal(d.connectionCounts.loopback, 2)
  assert.deepEqual(d.interfaces, ['\\Device\\NPF_Loopback'])
})
test('direct game connections on 80/443 are candidates for protocol validation', options, () => {
  const d = discover('direct'); assert.equal(d.status, 'running'); assert.deepEqual(d.flows.map(f => f.serverPort), [443, 80])
  assert.equal(d.interfaces.length, 1); assert.match(d.interfaces[0], /123456789abc/i)
})
test('mixed routing includes both physical and loopback interfaces without closed sockets', options, () => {
  const d = discover('mixed'); assert.equal(d.flows.length, 4); assert.equal(d.interfaces.length, 2)
  assert.equal(d.connectionCounts.established, 4)
})
test('unsupported IPv6 and absence of sockets remain distinguishable', options, () => {
  const v6 = discover('ipv6'), none = discover('none')
  assert.equal(v6.connectionCounts.ipv6, 1); assert.deepEqual(v6.flows, [])
  assert.equal(none.connectionCounts.established, 0); assert.deepEqual(none.flows, [])
})
test('discovery errors and changed process identity are not reported as no server connection', options, () => {
  const error = discover('query-error'), stale = discover('stale')
  assert.equal(error.status, 'access-error'); assert.match(error.error, /unavailable/)
  assert.equal(stale.status, 'access-error'); assert.match(stale.error, /process changed/)
})
