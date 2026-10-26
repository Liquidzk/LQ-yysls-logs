"""Version-pinned property names shared by buffs, identities and encounters."""
import hashlib,json,pathlib,sys
ROOT=pathlib.Path(__file__).resolve().parents[1]

class PropertyPreset:
 def __init__(self,build_hash=None):
  config=json.loads((ROOT/'config/client-build.json').read_text(encoding='utf-8-sig'))
  if build_hash:
   profiles=[p for p in config['builds'] if p['imageSha256']==build_hash]
   if len(profiles)!=1:raise ValueError('Unknown property preset build')
   profile=profiles[0]
  else:profile=next(p for p in config['builds'] if p['id']=='cn-win64rh-20261013')
  spec=profile['propertyPreset'];data=(ROOT/spec['file']).read_bytes()
  if hashlib.sha256(data).hexdigest()!=spec['sha256']:raise ValueError('Property preset evidence changed')
  parsed=json.loads(data)
  self.names=dict(enumerate(parsed['names'])) if 'names' in parsed else {r['index']:r['name'] for r in parsed['rows']}
  self.indexes={v:k for k,v in self.names.items()};self.id=profile['id'];self.sha256=spec['sha256']
 def key(self,v):
  if v.HasField('sindex'):return self.names.get(v.sindex,'sindex:'+str(v.sindex))
  if v.HasField('svalue'):
   try:text=v.svalue.decode('utf8')
   except UnicodeDecodeError:return v.svalue
   return text if text in self.indexes else v.svalue
  for name in ('ivalue','fvalue','dvalue','bvalue'):
   if v.HasField(name):return getattr(v,name)
  return None

_preset=None
def get_preset():
 global _preset
 if _preset is None:
  build=sys.argv[sys.argv.index('--client-build')+1] if '--client-build' in sys.argv else None
  _preset=PropertyPreset(build)
 return _preset
