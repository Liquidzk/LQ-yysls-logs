'use strict';
const fs=require('fs');
// Reuse descriptors and batch small derived-event writes. Raw packet evidence
// is written immediately and is also the decoder's durable backpressure queue.
class LedgerWriter {
 constructor(){this.files=new Map();this.timer=setInterval(()=>this.flush(),250);this.timer.unref();}
 append(file,text){let r=this.files.get(file);if(!r){r={fd:fs.openSync(file,'a'),chunks:[],size:0};this.files.set(file,r);}r.chunks.push(text);r.size+=Buffer.byteLength(text);if(r.size>=65536)this.flushFile(r);}
 flushFile(r){if(!r.size)return;fs.writeSync(r.fd,r.chunks.join(''));r.chunks=[];r.size=0;}
 flush(){for(const r of this.files.values())this.flushFile(r);}
 close(){clearInterval(this.timer);this.flush();for(const r of this.files.values())fs.closeSync(r.fd);this.files.clear();}
}
module.exports={LedgerWriter};
