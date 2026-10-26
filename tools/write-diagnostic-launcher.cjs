const fs = require('node:fs'), path = require('node:path')
function writeDiagnosticLauncher(output) {
  fs.writeFileSync(path.join(output, '检查当前游戏版本.cmd'), [
    '@echo off', 'chcp 65001 >nul',
    'echo 将只读检查客户端中手动绑定的游戏进程。资料只保存到本机，用于适配当前版本。',
    'echo 若 Windows 拒绝读取，请关闭此窗口，右键本文件选择“以管理员身份运行”。',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\\collector\\tools\\launch-build-diagnostic.ps1" -ClientDirectory "%~dp0."',
    'if errorlevel 1 (echo 检查失败，请保留以上错误信息。) else (echo 检查完成，可以返回对话告知已完成。)',
    'pause', ''
  ].join('\r\n'), 'utf8')
}
module.exports = { writeDiagnosticLauncher }
if (require.main === module) writeDiagnosticLauncher(process.argv[2])
