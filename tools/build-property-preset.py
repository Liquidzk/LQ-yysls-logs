"""Extract only a verified sequential list constructor; never execute game Lua."""
import hashlib,json,pathlib,sys
from lua54_reader import Reader

def extract(data):
    parsed=Reader(data).parse()
    assert len(parsed['prototypes'])==1
    proto=parsed['prototypes'][0];words=proto['instructions'];constants=proto['constants']
    assert all(c['tag'] in (4,20) and isinstance(c['value'],str) for c in constants)
    assert len({c['value'] for c in constants})==len(constants)
    assert set(w&127 for w in words)<=set((96,32,3,93,97,84))
    loaded=0;written=0;registers=[]
    for i,w in enumerate(words):
        op=w&127;a=(w>>7)&255
        if op==3:
            assert w>>15==loaded and a==len(registers)+1
            registers.append(a);loaded+=1
        elif op==93:
            b=(w>>16)&255;c=w>>24
            if (w>>15)&1:
                assert words[i+1]&127==97
                c+=(words[i+1]>>7)*256
            assert a==0 and b==len(registers) and c==written
            written+=b;registers=[]
    assert loaded==written==len(constants) and not registers
    return {'schemaVersion':1,'source':'engine/common/PresetStringIndex.lua',
            'sourceSha256':hashlib.sha256(data).hexdigest(),
            'validation':'Exact chunk parsing; unique strings; sequential LOADK and SETLIST destinations validated; no Lua execution',
            'names':['']+[c['value'] for c in constants]}

if __name__=='__main__':
    source=pathlib.Path(sys.argv[1]);output=pathlib.Path(sys.argv[2]);result=extract(source.read_bytes())
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps({'names':len(result['names']),'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}))
