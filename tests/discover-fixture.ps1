param([string]$DiscoveryScript,[string]$Scenario)
$ErrorActionPreference='Stop'
function Get-Process {
 [pscustomobject]@{Id=77;ProcessName='yysls';StartTime=[DateTime]::Parse('2026-01-01T00:00:00Z');MainModule=[pscustomobject]@{FileName='C:\fixture\yysls.exe';BaseAddress=[IntPtr]65536}}
}
function Get-NetTCPConnection {
 param([int]$OwningProcess,[string]$ErrorAction)
 if($OwningProcess -ne 77){throw 'Wrong process queried'}
 if($Scenario -eq 'query-error'){throw 'Fixture TCP table unavailable'}
 if($Scenario -eq 'none'){return}
 if($Scenario -in @('loopback','mixed')){
  [pscustomobject]@{State=5;LocalAddress='127.0.0.1';LocalPort=9000;RemoteAddress='127.0.0.1';RemotePort=1111}
  [pscustomobject]@{State=5;LocalAddress='127.0.0.2';LocalPort=9001;RemoteAddress='127.0.0.2';RemotePort=443}
 }
 if($Scenario -in @('direct','mixed')){
  [pscustomobject]@{State=5;LocalAddress='192.0.2.2';LocalPort=9002;RemoteAddress='192.0.2.1';RemotePort=443}
  [pscustomobject]@{State=5;LocalAddress='192.0.2.2';LocalPort=9003;RemoteAddress='192.0.2.1';RemotePort=80}
 }
 if($Scenario -eq 'ipv6'){
  [pscustomobject]@{State=5;LocalAddress='::1';LocalPort=9004;RemoteAddress='::1';RemotePort=1111}
 }
 [pscustomobject]@{State=8;LocalAddress='127.0.0.1';LocalPort=9005;RemoteAddress='127.0.0.1';RemotePort=1111}
}
function Get-NetAdapter {
 param([string]$ErrorAction)
 if($Scenario -eq 'loopback'){throw 'Loopback must not depend on physical adapter discovery'}
 [pscustomobject]@{Status='Up';InterfaceGuid=[Guid]'12345678-1234-1234-1234-123456789abc'}
}
function Get-NetUDPEndpoint {
 param([int]$OwningProcess,[string]$ErrorAction)
 if($OwningProcess -ne 77){throw 'Wrong UDP process queried'}
 if($Scenario -eq 'kcp'){[pscustomobject]@{LocalAddress='0.0.0.0';LocalPort=62613}}
}
$expected='2026-01-01T00:00:00Z'
if($Scenario -eq 'stale'){$expected='2025-01-01T00:00:00Z'}
& $DiscoveryScript -GameProcessId 77 -ExpectedStart $expected
