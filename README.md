# 燕云 Logs

## 直接使用

从 [Releases](https://github.com/Liquidzk/LQ-yysls-logs/releases) 下载 `win-x64.zip` 客户端压缩包，完整解压后运行 `燕云Logs.exe` 即可，无需自行构建。各功能操作见[客户端使用说明](docs/客户端使用说明.md)。

## 构建（Windows x64）

准备 Git、Node.js 22.12+ 和 Python 3.10+，在 PowerShell 中执行：

```powershell
git clone --recurse-submodules https://github.com/Liquidzk/LQ-yysls-logs.git
cd LQ-yysls-logs
npm ci
python -m pip install pyinstaller
node tools/prepare-collector.cjs "本机参考客户端的 resources 目录"
npm run build:engine
npm run package
```

将上面的目录替换为本机参考客户端（YyslsLogs）的 `resources` 路径，用于准备源码未附带的采集运行时和协议资源。需要中文名称时，在构建前将生成的名称表放入 `engine/name_catalog.json`；缺失时显示编号。

构建结果位于 `release/v<版本号>/LQ-yysls-logs-win32-x64/`，保持整个目录完整。开发运行可在完成引擎构建与资源准备后执行 `npm start`。
