const path = require('node:path')
const fs = require('node:fs')
const { packager } = require('@electron/packager')
const root = path.resolve(__dirname, '..')
const staging = path.join(root, 'build/v04/app')
fs.mkdirSync(path.join(staging, 'desktop'), { recursive: true })
for (const file of ['main.cjs', 'preload.cjs', 'capture-manager.cjs', 'star-action.cjs']) fs.copyFileSync(path.join(root, 'desktop', file), path.join(staging, 'desktop', file))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')))
const electronVersion = pkg.devDependencies.electron
delete pkg.devDependencies
delete pkg.dependencies
delete pkg.scripts
fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(pkg, null, 2))
fs.copyFileSync(path.join(root, 'COPYING'), path.join(staging, 'COPYING'))
// Package only the pinned sources, never the submodule's Git metadata.
const skin = path.join(root, 'build/v04/kagerou')
fs.mkdirSync(skin, { recursive: true })
for (const item of ['yanyun', 'COPYING', 'LICENSE.md']) fs.cpSync(path.join(root, 'vendor/kagerou', item), path.join(skin, item), { recursive: true })
const assets = path.join(root, 'build/v04/assets')
fs.mkdirSync(assets, { recursive: true })
const collector = path.join(root, 'runtime/collector')
if (!fs.existsSync(path.join(collector, 'runtime/node.exe'))) throw Error('Run prepare-collector.cjs before packaging')
for (const item of ['tools', 'config']) fs.cpSync(path.join(root, 'collector', item), path.join(collector, item), { recursive: true })
;(async () => {
  const outputs = await packager({ dir: staging, name: 'LQ-yysls-logs', executableName: '燕云Logs',
    platform: 'win32', arch: 'x64', electronVersion,
    out: path.join(root, 'release', 'v' + pkg.version), overwrite: true, asar: true,
    extraResource: [path.join(root, 'runtime/engine'), collector, skin, assets],
    win32metadata: { ProductName: '燕云 Logs', FileDescription: '燕云实时采集与战斗复盘', CompanyName: 'LQ-yysls-logs' } })
  for (const output of outputs) {
    require('./write-diagnostic-launcher.cjs').writeDiagnosticLauncher(output)
    if (fs.existsSync(path.join(root, 'desktop.local.json'))) fs.copyFileSync(path.join(root, 'desktop.local.json'), path.join(output, 'desktop.local.json'))
    fs.copyFileSync(path.join(root, 'docs/客户端使用说明.txt'), path.join(output, '使用说明.txt'))
  }
  console.log(outputs.join('\n'))
})().catch(error => { console.error(error); process.exitCode = 1 })
