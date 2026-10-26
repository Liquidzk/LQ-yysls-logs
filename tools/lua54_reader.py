"""Read Lua 5.4 chunk structure, never execute it or infer custom opcodes."""
import struct, json

class Reader:
    def __init__(self,b): self.b=b;self.pos=0;self.protos=[]
    def take(self,n):
        if n<0 or self.pos+n>len(self.b): raise ValueError(f'truncated at {self.pos}, requested {n}')
        out=self.b[self.pos:self.pos+n];self.pos+=n;return out
    def byte(self): return self.take(1)[0]
    def vi(self):
        n=0
        for _ in range(10):
            b=self.byte();n=(n<<7)|(b&127)
            if b&128:return n
        raise ValueError('oversize varint')
    def string(self):
        n=self.vi()
        if n==0:return None
        raw=self.take(n-1)
        try:return raw.decode('utf-8')
        except UnicodeDecodeError:return {'hex':raw.hex()}
    def proto(self,parent=None,depth=0):
        if depth>200:raise ValueError('depth limit')
        p={'offset':self.pos,'source':self.string() or parent,'line_start':self.vi(),'line_end':self.vi(),'params':self.byte(),'vararg':self.byte(),'stack':self.byte()}
        self.protos.append(p);p['prototype_index']=len(self.protos)-1
        n=self.vi();p['code_offset']=self.pos;p['instructions']=list(struct.unpack('<'+'I'*n,self.take(4*n)))
        p['constants']=[]
        for _ in range(self.vi()):
            off=self.pos;t=self.byte()
            if t==0:v=None
            elif t==1:v=False
            elif t==17:v=True
            elif t==3:v=struct.unpack('<q',self.take(8))[0]
            elif t==19:v=struct.unpack('<d',self.take(8))[0]
            elif t in (4,20):v=self.string()
            else:raise ValueError(f'unknown constant type {t} at {off}')
            p['constants'].append({'offset':off,'tag':t,'value':v})
        n=self.vi();p['upvalue_descriptors']=[list(self.take(3)) for _ in range(n)]
        p['children']=[self.proto(p['source'],depth+1)['prototype_index'] for _ in range(self.vi())]
        self.take(self.vi())
        for _ in range(self.vi()):self.vi();self.vi()
        p['locals']=[{'name':self.string(),'start':self.vi(),'end':self.vi()} for _ in range(self.vi())]
        p['upvalue_names']=[self.string() for _ in range(self.vi())]
        return p
    def parse(self):
        header=self.take(31)
        if header[:15]!=b'\x1bLuaT\x00\x19\x93\r\n\x1a\n\x04\x08\x08':raise ValueError('unsupported header')
        if struct.unpack('<q',header[15:23])[0]!=0x5678 or struct.unpack('<d',header[23:31])[0]!=370.5:raise ValueError('numeric header')
        n=self.byte();root=self.proto()
        if self.pos!=len(self.b):raise ValueError(f'trailing bytes {len(self.b)-self.pos}')
        return {'source':root['source'],'bytes':len(self.b),'upvalues':n,'prototypes':self.protos,'validation':'structure parsed to exact end; opcode semantics NOT validated'}

def source_name(b):
    r=Reader(b);r.take(32);return r.string()

def render(data):
    lines=[f"source: {data['source']}",data['validation'],'']
    for p in data['prototypes']:
        lines.append(f"PROTO {p['prototype_index']} source lines {p['line_start']}..{p['line_end']} offset {p['offset']} instructions {len(p['instructions'])}")
        for i,k in enumerate(p['constants']):lines.append(f"  K[{i}] @0x{k['offset']:x} = {json.dumps(k['value'],ensure_ascii=False)}")
        if p['locals']:lines.append('  locals: '+', '.join(str(x['name']) for x in p['locals']))
        lines.append('')
    return '\n'.join(lines)
