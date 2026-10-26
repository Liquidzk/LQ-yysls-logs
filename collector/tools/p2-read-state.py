"""Read-only, bounded static chain from the saved REA evidence; no scan or injection."""
import pathlib,json,struct,sys,ctypes,datetime,hashlib
q=pathlib.Path(sys.argv[1]);module=json.loads((q/'module.json').read_text(encoding='utf-8-sig'));trail=[];total=0
profiles=json.loads((pathlib.Path(__file__).resolve().parents[1]/'config/client-build.json').read_text(encoding='utf-8-sig'))
image_hash=hashlib.sha256(pathlib.Path(module['modulePath']).read_bytes()).hexdigest()
matches=[p for p in profiles.get('builds',[profiles]) if p['imageSha256']==image_hash]
if len(matches)!=1:raise RuntimeError('Unsupported or ambiguous client build; state offsets not applied')
profile=matches[0];offsets=profile['offsets']
k=ctypes.WinDLL('kernel32',use_last_error=True);k.OpenProcess.restype=ctypes.c_void_p;k.OpenProcess.argtypes=[ctypes.c_uint32,ctypes.c_bool,ctypes.c_uint32];k.ReadProcessMemory.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.POINTER(ctypes.c_size_t)];k.CloseHandle.argtypes=[ctypes.c_void_p]
handle=k.OpenProcess(0x0410,False,module['pid'])
if not handle:raise RuntimeError('Read-only process access denied; administrator launch required')
def u64(b,o=0):return struct.unpack_from('<Q',b,o)[0]
def u32(b,o=0):return struct.unpack_from('<I',b,o)[0]
def read(a,n,why):
 global total
 if not (65536<=a<0x7fffffffffff and 0<n<=1040) or total+n>4194304:raise RuntimeError('Bounded read rejected')
 total+=n;buf=ctypes.create_string_buffer(n);got=ctypes.c_size_t();at=datetime.datetime.now(datetime.timezone.utc).isoformat()
 if not k.ReadProcessMemory(handle,a,buf,n,ctypes.byref(got)) or got.value!=n:raise RuntimeError('Read failed')
 file=q/(str(len(trail))+'.private.bin');file.write_bytes(buf.raw);trail.append({'address':hex(a),'bytes':n,'purpose':why,'atUtc':at,'file':str(file)});return buf.raw
base=int(module['imageBase'],16)
def lookup(t,key):
 h=read(t,40,'Table header for exact key '+key);assert h[8] in (5,12)
 if h[8]==12:
  h=read(u64(h,32),40,'Custom instance dictionary for exact key '+key);lg=h[20];nodes=u64(h,24)
 else:lg=h[17];nodes=u64(h,32)
 assert lg<=24;count=1<<lg;hs=seed^len(key.encode())
 for c in key.encode()[::-1]:hs=(hs^(((hs<<5)+(hs>>2)+c)&0xffffffff))&0xffffffff
 index=hs&(count-1);seen=set()
 for _ in range(64):
  assert 0<=index<count and index not in seen;seen.add(index)
  node=read(nodes+24*index,24,'Exact '+key+' hashchain node')
  if node[9]==0x44:
   sp=u64(node,16);st=read(sp,32,'Exact '+key+' candidate string header')
   if st[8]==4 and st[17]==len(key.encode()) and read(sp+32,len(key.encode()),'Exact '+key+' string equality')==key.encode():return (u64(node),node[8])
  d=struct.unpack_from('<i',node,12)[0]
  if not d:return None
  index+=d
 raise RuntimeError('Exact hashchain bound reached')
result={'pid':module['pid'],'profileId':profile['id'],'scope':'Exact static field chain only; no scan, mutation, hook or target execution'}
try:
 for guard in profile.get('codeGuards',[]):
  expected=bytes.fromhex(guard['bytes'])
  if read(base+int(guard['rva'],16),len(expected),'Exact build code guard '+guard['purpose'])!=expected:raise RuntimeError('Build code validation failed: '+guard['purpose'])
 root=read(base+int(offsets['luaRootRva'],16),16,'Module-relative main Lua runtime root; state pointer offset8')
 L=read(u64(root,8),64,'Known Lua state header, global_State offset0x20')
 g=read(u64(L,32),112,'Known global_State registry TValue and string seed')
 seed=u32(g,96)
 reg=u64(g,64);assert g[72]==0x45
 h=read(reg,40,'Registry header for global integer2');assert h[8]==5 and u32(h,20)>=2
 gv=read(u64(h,24)+16,16,'Registry globals integer2 TValue');assert gv[8]==0x45
 G=lookup(u64(gv),'G')
 if G is None:
  loaded=lookup(reg,'_LOADED');assert loaded and loaded[1]==0x45;G=lookup(loaded[0],'hexm.client.G')
 assert G and G[1]==0x45
 net=lookup(G[0],'net');assert net
 asio=lookup(net[0],'_asio_gate_client');assert asio and asio[1]==0x4c
 obj=read(asio[0],80,'Asio engineobject rpc_handler type19 and native pointer');assert obj[8]==12 and u64(obj,48)>=16 and struct.unpack_from('<H',obj,64)[0]==19
 handler=read(u64(obj,72),32,'rpc_handler implementation pointer at+8')
 impl=read(u64(handler,8),144,'Native connection implementation, transform at+0x50')
 trans=read(u64(impl,80),48,'Connection cipher transform, inbound wrapper at+0x10')
 wrapper=read(u64(trans,16),16,'Inbound cipher wrapper vtable and object pointer');assert u64(wrapper)==(base+int(offsets['inboundWrapperVtableRva'],16))
 cipher=read(u64(wrapper,8),1040,'Exact inbound RC4 object snapshot for current captured stream alignment');assert u64(cipher)==(base+int(offsets['rc4VtableRva'],16))
 assert sorted(u32(cipher,16+4*i) for i in range(256))==list(range(256))
 result.update(status='snapshot-ready',stateObject=trail[-1]['file'],snapshotAtUtc=trail[-1]['atUtc'],expectedVtable=hex(base+int(offsets['rc4VtableRva'],16)))
except Exception as e:result.update(status='stopped',reason=str(e) or 'Structure validation failed after '+(trail[-1]['purpose'] if trail else 'initialization'))
result['reads']=trail;(q/'rpc-state-recovery.json').write_text(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in result.items() if k not in ('reads','stateObject')}))

k.CloseHandle(handle)
