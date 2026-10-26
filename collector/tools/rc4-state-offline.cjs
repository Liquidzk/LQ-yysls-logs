// Offline only. Reads a caller-supplied RC4 object snapshot; never opens a process.
const fs = require('fs');
const crypto = require('crypto');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
function validate(s) {
  if (!Number.isInteger(s.i) || s.i < 0 || s.i > 255 || !Number.isInteger(s.j) || s.j < 0 || s.j > 255) throw Error('Invalid RC4 indices');
  if (s.S.length !== 256 || new Set(s.S).size !== 256 || !s.S.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) throw Error('State is not a permutation of 0..255');
  return s;
}
function stateFromObject(b, expectedVtable = 0x145b7ff98n) {
  if (b.length !== 0x410) throw Error('Expected exact 0x410-byte native RC4 object');
  if (b.readBigUInt64LE(0) !== expectedVtable) throw Error('Unexpected RC4 object vtable');
  return validate({i: b.readUInt32LE(8), j: b.readUInt32LE(12), S: Array.from({length: 256}, (_, n) => b.readUInt32LE(16 + 4*n))});
}
function init(key) {
  if (!key.length) throw Error('Empty key');
  const s = {i: 0, j: 0, S: Array.from({length: 256}, (_, i) => i)};
  for (let i = 0, j = 0; i < 256; i++) { j = (j+s.S[i]+key[i % key.length])&255; [s.S[i],s.S[j]]=[s.S[j],s.S[i]]; }
  return s;
}
function step(s) {
  s.i=(s.i+1)&255; s.j=(s.j+s.S[s.i])&255;
  [s.S[s.i],s.S[s.j]]=[s.S[s.j],s.S[s.i]];
  return s.S[(s.S[s.i]+s.S[s.j])&255];
}
function backstep(s) {
  const k=s.S[(s.S[s.i]+s.S[s.j])&255];
  [s.S[s.i],s.S[s.j]]=[s.S[s.j],s.S[s.i]];
  s.j=(s.j-s.S[s.i])&255; s.i=(s.i-1)&255;
  return k;
}
function crypt(s, input) { const out=Buffer.alloc(input.length); for(let n=0;n<input.length;n++)out[n]=input[n]^step(s); return out; }
function rewind(s, count) { if(!Number.isSafeInteger(count)||count<0)throw Error('Invalid rewind count');for(let n=0;n<count;n++)backstep(s); return s; }
function decryptPreceding(s, ciphertext) { const out=Buffer.alloc(ciphertext.length); for(let n=ciphertext.length-1;n>=0;n--)out[n]=ciphertext[n]^backstep(s); return out; }
module.exports={validate,stateFromObject,init,step,backstep,crypt,rewind,decryptPreceding};
if(require.main===module) {
  const [statePath,cipherPath,clearPrefix,bytesAfterCapture,outputPath]=process.argv.slice(2);
  if(!outputPath)throw Error('Usage: node rc4-state-offline.cjs STATE_OBJECT CIPHER_STREAM CLEAR_PREFIX_BYTES BYTES_AFTER_CAPTURE OUTPUT');
  if(fs.existsSync(outputPath))throw Error('Refusing to overwrite output');
  const stateBytes=fs.readFileSync(statePath),cipher=fs.readFileSync(cipherPath),prefix=Number(clearPrefix),after=Number(bytesAfterCapture);
  if(!Number.isSafeInteger(prefix)||prefix<0||prefix>cipher.length)throw Error('Invalid prefix');
  const state=stateFromObject(stateBytes);rewind(state,after);
  const result=decryptPreceding(state,cipher.subarray(prefix));fs.writeFileSync(outputPath,result);
  console.log(JSON.stringify({statePath,stateSha256:sha256(stateBytes),cipherPath,cipherSha256:sha256(cipher),clearPrefixBytes:prefix,bytesAfterCapture:after,outputPath,outputBytes:result.length,outputSha256:sha256(result),limits:['A valid RC4 permutation does not establish snapshot atomicity or stream position.','Caller must establish the same connection, direction, processing count, compression order and clear-prefix boundary.','Plaintext remains unverified until framing and protocol/schema validation succeed.']}));
}
