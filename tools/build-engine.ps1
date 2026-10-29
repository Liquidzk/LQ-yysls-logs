param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
Push-Location $projectDir
try {
  & $Python -m PyInstaller --noconfirm --clean --onedir --name yanyun-engine --distpath runtime --workpath build/engine --specpath build --paths "$projectDir/engine/vendor" --add-data "$projectDir/engine/event_schema.json;." --add-data "$projectDir/collector/config/boss-entities.json;." --add-data "$projectDir/engine/web;web" "$projectDir/engine/desktop_server.py"
  if ($LASTEXITCODE -ne 0) { throw '解析引擎构建失败' }
  # Packager expects a stable resource directory, separate from build artifacts.
  New-Item -ItemType Directory -Path runtime/engine -Force | Out-Null
  Copy-Item -Path runtime/yanyun-engine/* -Destination runtime/engine -Recurse -Force
  if (Test-Path -LiteralPath engine/name_catalog.json) {
    Copy-Item -LiteralPath engine/name_catalog.json -Destination runtime/engine/_internal/name_catalog.json -Force
  }
} finally { Pop-Location }
