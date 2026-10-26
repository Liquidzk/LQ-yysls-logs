// Import only the decoder assets and runtimes required by the reviewed collector.
// Raw captures, session keys, player identities and historical logs are excluded.
const fs = require('node:fs'), path = require('node:path')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const source = process.argv[2]
if (!source) throw Error('Usage: node tools/prepare-collector.cjs <reference resources directory>')
const target = path.join(root, 'runtime/collector')
const copy = (relative) => {
  const from = path.join(source, relative), to = path.join(target, relative)
  if (!fs.existsSync(from)) throw Error('Missing collector asset: ' + relative)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true, filter: p => !['__pycache__', 'capstone', 'tests'].includes(path.basename(p)) && !p.endsWith('.pyc') })
}
for (const file of ['runtime/node.exe', 'runtime/python', 'runtime/wireshark',
  'evidence/p0/runtime-rpc-analysis/common.proto.descriptor.bin',
  'evidence/p0/runtime-rpc-analysis/client_gate.proto.descriptor.bin',
  'evidence/p0/runtime-rpc-analysis/pydeps/google',
  'evidence/p0/runtime-rpc-analysis/pydeps/protobuf-7.36.2.dist-info',
  'evidence/p1/encounter-retest/index-names.json']) copy(file)
// The reviewed source is always taken from our tree, never from a mutable reference installation.
fs.cpSync(path.join(root, 'collector/tools'), path.join(target, 'tools'), { recursive: true })
fs.cpSync(path.join(root, 'collector/config'), path.join(target, 'config'), { recursive: true })
fs.cpSync(path.join(root, 'node_modules/@msgpack/msgpack'), path.join(target, 'tools/node_modules/@msgpack/msgpack'), { recursive: true })
fs.copyFileSync(path.join(root, 'COPYING'), path.join(target, 'COPYING'))
fs.copyFileSync(path.join(root, 'collector/NOTICE.txt'), path.join(target, 'NOTICE.txt'))
const nodeVersion = execFileSync(path.join(target, 'runtime/node.exe'), ['--version'], { windowsHide: true, encoding: 'utf8' }).trim()
fs.copyFileSync(path.join(root, 'collector/licenses', 'node-' + nodeVersion + '-LICENSE.txt'), path.join(target, 'runtime/NODE-LICENSE.txt'))
console.log('Prepared local collector resources: ' + target)
