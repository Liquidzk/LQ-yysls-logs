param([Parameter(Mandatory=$true)][int]$GameProcessId,[Parameter(Mandatory=$true)][string]$ExpectedStart)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
 $game=Get-Process -Id $GameProcessId -ErrorAction SilentlyContinue
 if(-not $game){@{status='waiting-game'}|ConvertTo-Json -Compress;exit}
 if($game.ProcessName -ne 'yysls' -or $game.StartTime.ToUniversalTime().Ticks -ne [DateTime]::Parse($ExpectedStart).ToUniversalTime().Ticks){throw 'Selected process changed; select the game process again'}
 $module=$game.MainModule
 if(-not $module){throw 'Game module is inaccessible; administrator launch required'}
 try { $connections=@(Get-NetTCPConnection -OwningProcess $game.Id -ErrorAction Stop) }
 catch { if($_.CategoryInfo.Category -eq 'ObjectNotFound'){$connections=@()}else{throw} }
 $established=@($connections | Where-Object {[int]$_.State -eq 5})
 # The chosen game may connect through a local accelerator/proxy. A loopback
 # peer is still the game's own socket; never substitute the proxy's process.
 # Keep 80/443 too: validated protocol alignment, not port numbers, selects RPC.
 $flows=@($established | Where-Object {$_.RemoteAddress -notmatch ':' -and $_.LocalAddress -notmatch ':'} | ForEach-Object {
  @{clientAddress=$_.LocalAddress;clientPort=$_.LocalPort;serverAddress=$_.RemoteAddress;serverPort=$_.RemotePort;
    loopback=[System.Net.IPAddress]::IsLoopback([System.Net.IPAddress]::Parse($_.RemoteAddress))}
 })
 $loopbackCount=@($flows | Where-Object {$_.loopback}).Count
 try { $udp=@(Get-NetUDPEndpoint -OwningProcess $game.Id -ErrorAction Stop | Where-Object {$_.LocalAddress -notmatch ':'} | ForEach-Object {@{clientAddress=$_.LocalAddress;clientPort=$_.LocalPort}}) }
 catch { if($_.CategoryInfo.Category -eq 'ObjectNotFound'){$udp=@()}else{throw} }
 $interfaces=@()
 if($loopbackCount -gt 0){$interfaces+='\Device\NPF_Loopback'}
 if(@($flows | Where-Object {-not $_.loopback}).Count -gt 0 -or $udp.Count -gt 0){
  $interfaces+=@(Get-NetAdapter -ErrorAction Stop | Where-Object {$_.Status -eq 'Up'} | ForEach-Object {'\Device\NPF_{'+$_.InterfaceGuid.ToString().Trim('{}')+'}'})
 }
 @{status='running';pid=$game.Id;processStartUtc=$game.StartTime.ToUniversalTime().ToString('o');imageBase=('0x'+$module.BaseAddress.ToInt64().ToString('x'));modulePath=$module.FileName;flows=$flows;interfaces=$interfaces;udpEndpoints=$udp;
   connectionCounts=@{established=$established.Count;ipv4=$flows.Count;ipv6=$established.Count-$flows.Count;loopback=$loopbackCount}} | ConvertTo-Json -Depth 5 -Compress
} catch {@{status='access-error';error=$_.Exception.Message}|ConvertTo-Json -Compress}
