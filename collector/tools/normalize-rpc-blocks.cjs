// Offline reconstruction of the observed block_compressor framing.
const fs=require('fs'),zlib=require('zlib'),crypto=require('crypto');
function normalize(input, {maxBodyBytes=64*1024*1024, allowIncompleteTail=false}={}) {
  let pos=0,outputBytes=0;const chunks=[],records=[];
  while(pos<input.length){
    const start=pos;
    if(input.length-pos<4){if(allowIncompleteTail)break;throw Error('Incomplete block header');}
    const flags=input.readUInt32LE(pos),compressed=!!(flags&0x80000000),n=flags&0x7fffffff;
    if(n<2||n>maxBodyBytes)throw Error('Invalid or excessive body length at '+pos);
    if(input.length-pos-4<n){if(allowIncompleteTail)break;throw Error('Incomplete block body');}
    let body;
    if(compressed){
      if(n<5)throw Error('Compressed block too short');
      const u=input.readUInt32LE(pos+4);if(u<2||u>maxBodyBytes)throw Error('Invalid uncompressed body length');
      body=zlib.zstdDecompressSync(input.subarray(pos+8,pos+4+n),{maxOutputLength:maxBodyBytes});
      if(body.length!==u)throw Error('Decompressed size mismatch');
    }else body=input.subarray(pos+4,pos+4+n);
    const h=Buffer.alloc(4);h.writeUInt32LE(body.length);chunks.push(h,body);
    records.push({inputOffset:start,inputBytes:n+4,compressed,outputOffset:outputBytes,bodyBytes:body.length,methodIndex:body.readUInt16LE(0)});
    pos+=4+n;outputBytes+=4+body.length;
  }
  return {output:Buffer.concat(chunks),records,consumedBytes:pos,tailBytes:input.length-pos};
}
module.exports={normalize};
if(require.main===module){
 const [inputPath,outputPath]=process.argv.slice(2);if(!outputPath)throw Error('Usage: node normalize-rpc-blocks.cjs INPUT OUTPUT');if(fs.existsSync(outputPath))throw Error('Refusing overwrite');
 const input=fs.readFileSync(inputPath),r=normalize(input,{allowIncompleteTail:true});fs.writeFileSync(outputPath,r.output);const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
 const report={inputPath,inputSha256:hash(input),outputPath,outputSha256:hash(r.output),outputBytes:r.output.length,consumedBytes:r.consumedBytes,tailBytes:r.tailBytes,recordCount:r.records.length,records:r.records,limits:['Valid framing and decompression do not identify entity method parameters or combat semantics.','Incomplete final record is retained only as tail count; no claim of full capture coverage.']};fs.writeFileSync(outputPath+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify({recordCount:r.records.length,compressed:r.records.filter(x=>x.compressed).length,tailBytes:r.tailBytes,outputSha256:report.outputSha256}));
}
