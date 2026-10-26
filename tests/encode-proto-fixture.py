"""Encode synthetic protocol messages using the locally imported descriptors."""
import pathlib, sys, json, base64, struct
root = pathlib.Path(__file__).resolve().parents[1] / 'runtime/collector/evidence/p0/runtime-rpc-analysis'
sys.path.insert(0, str(root / 'pydeps'))
from google.protobuf import descriptor_pool, message_factory, json_format
pool = descriptor_pool.DescriptorPool()
for name in ('common.proto', 'client_gate.proto'):
    pool.AddSerializedFile((root / (name + '.descriptor.bin')).read_bytes())
types = [message_factory.GetMessageClass(m.input_type) for m in pool.FindServiceByName('mobile.server.lua.IGateClient').methods]
out = []
for row in json.load(sys.stdin):
    message = types[row['methodIndex']]()
    json_format.ParseDict(row['message'], message)
    assert message.IsInitialized(), message.FindInitializationErrors()
    out.append(base64.b64encode(struct.pack('<H', row['methodIndex']) + message.SerializeToString()).decode())
print(json.dumps(out))
