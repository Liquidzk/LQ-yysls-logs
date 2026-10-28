param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$c=Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class P1ProcessIdentity {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint a,bool b,uint p);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder b,ref uint n);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("iphlpapi.dll",SetLastError=true)] static extern uint GetExtendedTcpTable(IntPtr table,ref int size,bool order,uint family,int tableClass,uint reserved);
 [DllImport("iphlpapi.dll",SetLastError=true)] static extern uint GetExtendedUdpTable(IntPtr table,ref int size,bool order,uint family,int tableClass,uint reserved);
 public static int UdpEndpoints(int pid,int[] ports){
  int size=0;uint rc=GetExtendedUdpTable(IntPtr.Zero,ref size,false,2,1,0);
  if(rc!=122&&rc!=0)throw new System.ComponentModel.Win32Exception((int)rc);
  for(int attempt=0;attempt<3;attempt++){
   IntPtr table=Marshal.AllocHGlobal(size);
   try{rc=GetExtendedUdpTable(table,ref size,false,2,1,0);if(rc==122)continue;if(rc!=0)throw new System.ComponentModel.Win32Exception((int)rc);
    int count=Marshal.ReadInt32(table),matches=0;
    for(int i=0;i<count;i++){IntPtr row=IntPtr.Add(table,4+12*i);if(Marshal.ReadInt32(row,8)==pid&&Array.IndexOf(ports,Port(Marshal.ReadInt32(row,4)))>=0)matches++;}return matches;
   }finally{Marshal.FreeHGlobal(table);}
  }throw new InvalidOperationException("UDP table changed during bounded read");
 }
 static int Port(int v){return ((v&255)<<8)|((v>>8)&255);}
 static string Address(int v){return new System.Net.IPAddress(BitConverter.GetBytes(v)).ToString();}
 public static int Connections(int pid,string local,int localPort,string remote,int remotePort){
  int size=0;uint rc=GetExtendedTcpTable(IntPtr.Zero,ref size,false,2,5,0);
  if(rc!=122&&rc!=0)throw new System.ComponentModel.Win32Exception((int)rc);
  for(int attempt=0;attempt<3;attempt++){
   IntPtr table=Marshal.AllocHGlobal(size);
   try{rc=GetExtendedTcpTable(table,ref size,false,2,5,0);if(rc==122)continue;if(rc!=0)throw new System.ComponentModel.Win32Exception((int)rc);
    int count=Marshal.ReadInt32(table),matches=0;
    for(int i=0;i<count;i++){IntPtr row=IntPtr.Add(table,4+24*i);
     if(Marshal.ReadInt32(row)==5&&Marshal.ReadInt32(row,20)==pid&&Address(Marshal.ReadInt32(row,4))==local&&Port(Marshal.ReadInt32(row,8))==localPort&&Address(Marshal.ReadInt32(row,12))==remote&&Port(Marshal.ReadInt32(row,16))==remotePort)matches++;
    }return matches;
   }finally{Marshal.FreeHGlobal(table);}
  }throw new InvalidOperationException("TCP table changed during bounded read");
 }
 public static string Image(uint p){IntPtr h=OpenProcess(0x1000,false,p);if(h==IntPtr.Zero)return null;try{var b=new StringBuilder(32768);uint n=32768;return QueryFullProcessImageName(h,0,b,ref n)?b.ToString():null;}finally{CloseHandle(h);}}
}
'@
while($true){
 try{
  $game=Get-Process -Id $c.pid -ErrorAction Stop
  $start=$game.StartTime.ToUniversalTime().ToString('o')
  $sameStart=[DateTime]::Parse($start).ToUniversalTime().Ticks -eq [DateTime]::Parse($c.processStartUtc).ToUniversalTime().Ticks
  $samePath=[P1ProcessIdentity]::Image($c.pid) -eq $c.processPath
  if($c.transport -eq 'kcp'){$matches=[P1ProcessIdentity]::UdpEndpoints($c.pid,[int[]]$c.bindingUdpPorts);$connected=$matches -gt 0}
  else{$matches=[P1ProcessIdentity]::Connections($c.pid,$c.flow.clientAddress,$c.flow.clientPort,$c.flow.serverAddress,$c.flow.serverPort);$connected=$matches -eq 1}
  $ok=$sameStart -and $samePath -and $connected
  @{valid=$ok;at=[DateTime]::UtcNow.ToString('o');reason=$(if($ok){'PID start time, image path and transport binding match'}else{'Process identity or transport endpoint changed'})} | ConvertTo-Json -Compress
  if(-not $ok){break}
 }catch{@{valid=$false;at=[DateTime]::UtcNow.ToString('o');reason='Bound process/connection no longer verifiable'} | ConvertTo-Json -Compress;break}
 Start-Sleep -Seconds 1
}
