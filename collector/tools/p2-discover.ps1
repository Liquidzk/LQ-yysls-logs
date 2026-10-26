param([Parameter(Mandatory=$true)][int]$GameProcessId,[Parameter(Mandatory=$true)][string]$ExpectedStart)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
 $game=Get-Process -Id $GameProcessId -ErrorAction SilentlyContinue
 if(-not $game){@{status='waiting-game'}|ConvertTo-Json -Compress;exit}
 if($game.ProcessName -ne 'yysls' -or $game.StartTime.ToUniversalTime().Ticks -ne [DateTime]::Parse($ExpectedStart).ToUniversalTime().Ticks){throw 'Selected process changed; select the game process again'}
 $module=$game.MainModule
 if(-not $module){throw 'Game module is inaccessible; administrator launch required'}
 $flows=@(Get-NetTCPConnection -OwningProcess $game.Id -State Established -ErrorAction SilentlyContinue | Where-Object {$_.RemotePort -ne 443 -and $_.RemotePort -ne 80 -and $_.RemoteAddress -ne '127.0.0.1' -and $_.RemoteAddress -notmatch ':'} | ForEach-Object {@{clientAddress=$_.LocalAddress;clientPort=$_.LocalPort;serverAddress=$_.RemoteAddress;serverPort=$_.RemotePort}})
 $adapters=@(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {$_.Status -eq 'Up'} | ForEach-Object {'\Device\NPF_{'+$_.InterfaceGuid.ToString().Trim('{}')+'}'})
 @{status='running';pid=$game.Id;processStartUtc=$game.StartTime.ToUniversalTime().ToString('o');imageBase=('0x'+$module.BaseAddress.ToInt64().ToString('x'));modulePath=$module.FileName;flows=$flows;interfaces=$adapters} | ConvertTo-Json -Depth 5 -Compress
} catch {@{status='access-error';error=$_.Exception.Message}|ConvertTo-Json -Compress}
