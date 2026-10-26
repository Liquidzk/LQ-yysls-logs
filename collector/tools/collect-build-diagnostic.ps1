param(
 [Parameter(Mandatory=$true)][string]$BindingFile,
 [Parameter(Mandatory=$true)][string]$OutputDirectory
)
# User-run only. This is never launched by the collector or on app startup.
# Exact manually selected process; code/read-only sections only, no heap or keys.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
function Get-DiagnosticHash([string]$file){
 $algorithm=[Security.Cryptography.SHA256]::Create();$stream=[IO.File]::OpenRead($file)
 try {return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}
 finally {$stream.Dispose();$algorithm.Dispose()}
}
$out=$null
try {
 $binding=Get-Content -LiteralPath $BindingFile -Raw -Encoding UTF8 | ConvertFrom-Json
 if(-not $binding.pid -or -not $binding.startedAt -or -not $binding.path){throw 'No manual binding. Select the game in the client first.'}
 $game=Get-Process -Id $binding.pid -ErrorAction Stop
 if($game.ProcessName -ne 'yysls' -or $game.StartTime.ToUniversalTime().Ticks -ne [DateTime]::Parse($binding.startedAt).ToUniversalTime().Ticks){throw 'Selected game has changed. Bind it manually again first.'}
 $module=$game.MainModule
 if(-not $module -or -not $module.FileName){throw 'Windows denied access. Run this diagnostic as administrator yourself.'}
 if($module.FileName -ne $binding.path){throw 'Selected game image path changed.'}
 $disk=[IO.File]::ReadAllBytes($module.FileName)
 if($disk.Length -lt 512 -or $disk[0] -ne 77 -or $disk[1] -ne 90){throw 'Invalid game PE image.'}
 $pe=[BitConverter]::ToInt32($disk,60)
 if($pe -lt 64 -or $pe+264 -ge $disk.Length -or [BitConverter]::ToUInt32($disk,$pe) -ne 17744 -or [BitConverter]::ToUInt16($disk,$pe+24) -ne 523){throw 'Unsupported PE header.'}
 $count=[BitConverter]::ToUInt16($disk,$pe+6);$opt=[BitConverter]::ToUInt16($disk,$pe+20)
 $imageSize=[BitConverter]::ToUInt32($disk,$pe+80)
 if($count -gt 96 -or $pe+24+$opt+$count*40 -gt $disk.Length){throw 'Invalid PE section table.'}
 $sections=@();$budget=0
 for($i=0;$i -lt $count;$i++){
  $s=$pe+24+$opt+$i*40;$name=[Text.Encoding]::ASCII.GetString($disk,$s,8).Trim([char]0)
  if($name -notin @('.text','.rdata')){continue}
  $size=[BitConverter]::ToUInt32($disk,$s+8);$rva=[BitConverter]::ToUInt32($disk,$s+12)
  $flags=[BitConverter]::ToUInt32($disk,$s+36)
  if(($flags -band 0x80000000L) -ne 0 -or $size -eq 0 -or [long]$rva+$size -gt $imageSize){throw 'Selected section is writable or outside the main image.'}
  $budget+=$size;$sections+=@{name=$name;size=$size;rva=$rva}
 }
 if($budget -gt 160MB -or $sections.Count -ne 2 -or @($sections.name | Select-Object -Unique).Count -ne 2){throw 'Unexpected code section layout or read budget.'}
 Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YanyunBuildReader {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr h,IntPtr a,byte[] b,UIntPtr n,out UIntPtr r);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
 $handle=[YanyunBuildReader]::OpenProcess(0x0410,$false,$game.Id)
 if($handle -eq [IntPtr]::Zero){throw ('Windows read-only access denied ('+[Runtime.InteropServices.Marshal]::GetLastWin32Error()+'). Run the diagnostic as administrator yourself.')}
 try {
  $hash=Get-DiagnosticHash $module.FileName
  $out=Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) ([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')+'-'+$game.Id)
  New-Item -ItemType Directory -Path $out -ErrorAction Stop | Out-Null
  $results=@()
  foreach($section in $sections){
   $file=Join-Path $out ($section.name.TrimStart('.')+'.bin')
   $stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
   $chunks=@();$position=0
   try {
    while($position -lt $section.size){
     $length=[int][Math]::Min(1MB,$section.size-$position);$buffer=New-Object byte[] $length;$read=[UIntPtr]::Zero
     $address=$module.BaseAddress.ToInt64()+$section.rva+$position
     $ok=[YanyunBuildReader]::ReadProcessMemory($handle,[IntPtr]$address,$buffer,[UIntPtr]::new([uint64]$length),[ref]$read)
     $errorCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error();$got=[int]$read.ToUInt64()
     if($got -gt $length){throw 'Invalid read count.'}
     if(-not $ok -or $got -ne $length){[Array]::Clear($buffer,$got,$length-$got)}
     $stream.Write($buffer,0,$length)
     $chunks+=@{offset=$position;requested=$length;read=$got;success=$ok;win32Error=$(if($ok){0}else{$errorCode})}
     $position+=$length
    }
   } finally {$stream.Dispose()}
   $results+=@{name=$section.name;rva=$section.rva;bytes=$section.size;file=$file;sha256=(Get-DiagnosticHash $file);chunks=$chunks}
  }
  if($game.HasExited){throw 'Selected process exited during diagnostic.'}
  @{atUtc=[DateTime]::UtcNow.ToString('o');pid=$game.Id;processStartUtc=$binding.startedAt;source=$module.FileName;diskSha256=$hash;imageBase=('0x'+$module.BaseAddress.ToInt64().ToString('x'));sections=$results;
    scope='Explicit user-run read-only .text/.rdata snapshot of manually bound main module. No heap, writable sections, injection, protection changes or network upload. Partial reads are marked and zero-filled; not an atomic snapshot.'} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $out 'manifest.json') -Encoding UTF8
  Write-Host "Saved locally: $out"
 } finally {[void][YanyunBuildReader]::CloseHandle($handle)}
} catch {
 if($out){@{error=$_.Exception.Message;atUtc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'error.json') -Encoding UTF8}
 Write-Error $_.Exception.Message
 exit 1
}
