param([Parameter(Mandatory=$true)][string]$ClientDirectory)
$ErrorActionPreference='Stop'
# Match the desktop's settings order; never enumerate or choose a game here.
$appName='LQ '+[char]0x71D5+[char]0x4E91+' Logs'
$preferenceRoot=Join-Path $env:APPDATA $appName
$dataDir=Join-Path $preferenceRoot 'data'
foreach($config in @((Join-Path $ClientDirectory 'desktop.local.json'),(Join-Path $preferenceRoot 'paths.json'))){
 if(Test-Path -LiteralPath $config){
  $settings=Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
  if($settings.dataDir){$dataDir=$settings.dataDir}
 }
}
$captures=Join-Path $dataDir 'captures'
& (Join-Path $PSScriptRoot 'collect-build-diagnostic.ps1') -BindingFile (Join-Path $captures 'binding.private.json') -OutputDirectory (Join-Path $captures 'compatibility')
exit $LASTEXITCODE
