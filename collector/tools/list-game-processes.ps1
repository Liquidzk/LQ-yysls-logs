$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$rows=@(Get-Process -Name yysls -ErrorAction SilentlyContinue | ForEach-Object {
 try { [pscustomobject]@{pid=$_.Id;name=$_.ProcessName;title=$_.MainWindowTitle;path=$_.MainModule.FileName;startedAt=$_.StartTime.ToUniversalTime().ToString('o');accessible=$true} }
 catch { [pscustomobject]@{pid=$_.Id;name=$_.ProcessName;title=$_.MainWindowTitle;path='';startedAt='';accessible=$false} }
})
ConvertTo-Json -InputObject $rows -Compress
