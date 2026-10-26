param([string]$DiagnosticScript,[string]$FixtureDirectory,[switch]$WritableSection)
$ErrorActionPreference='Stop'
# A synthetic PE and allocated test bytes inside THIS PowerShell process only.
# Production diagnostic is unchanged; no real game is queried or read.
$fixtureFile=Join-Path $FixtureDirectory 'fixture.exe'
$disk=New-Object byte[] 1024
$disk[0]=77;$disk[1]=90
function Put([int]$offset,[byte[]]$value){[Array]::Copy($value,0,$disk,$offset,$value.Length)}
Put 60 ([BitConverter]::GetBytes([int]128))
Put 128 ([BitConverter]::GetBytes([uint32]17744))
Put 134 ([BitConverter]::GetBytes([uint16]2))
Put 148 ([BitConverter]::GetBytes([uint16]240))
Put 152 ([BitConverter]::GetBytes([uint16]523))
Put 208 ([BitConverter]::GetBytes([uint32]8192))
Put 392 ([Text.Encoding]::ASCII.GetBytes('.text'))
Put 400 ([BitConverter]::GetBytes([uint32]256))
Put 404 ([BitConverter]::GetBytes([uint32]4096))
Put 428 ([BitConverter]::GetBytes([uint32]0x60000020))
Put 432 ([Text.Encoding]::ASCII.GetBytes('.rdata'))
Put 440 ([BitConverter]::GetBytes([uint32]256))
Put 444 ([BitConverter]::GetBytes([uint32]4352))
$flags=1073741888L;if($WritableSection){$flags=3221225536L}
Put 468 ([BitConverter]::GetBytes([uint32]$flags))
[IO.File]::WriteAllBytes($fixtureFile,$disk)
$memory=[Runtime.InteropServices.Marshal]::AllocHGlobal(512)
$bytes=[byte[]](0..255 + 0..255)
[Runtime.InteropServices.Marshal]::Copy($bytes,0,$memory,512)
$fixtureStart='2026-01-01T00:00:00Z'
$binding=Join-Path $FixtureDirectory 'binding.json'
@{pid=$PID;startedAt=$fixtureStart;path=$fixtureFile} | ConvertTo-Json | Set-Content -LiteralPath $binding -Encoding UTF8
function Get-Process {
 param([int]$Id,[string]$ErrorAction)
 if($Id -ne $PID){throw 'Fixture must only address itself'}
 [pscustomobject]@{Id=$PID;ProcessName='yysls';StartTime=[DateTime]::Parse($fixtureStart);HasExited=$false;MainModule=[pscustomobject]@{FileName=$fixtureFile;BaseAddress=[IntPtr]($memory.ToInt64()-4096)}}
}
try { & $DiagnosticScript -BindingFile $binding -OutputDirectory (Join-Path $FixtureDirectory 'output') }
finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($memory)}
