'use strict';
const fs=require('fs');
// Derived UI snapshots must never terminate packet capture. Keep the last good
// file while Windows readers temporarily deny replacement; coalesce newer data.
class SnapshotPublisher {
 constructor({io=fs,retryMs=50,maxRetryMs=1000}={}){this.io=io;this.retryMs=retryMs;this.maxRetryMs=maxRetryMs;this.pending=new Map();this.timer=null;this.failures=0;this.lastError=null;this.closed=false;}
 write(file,data){if(this.closed)throw Error('Snapshot publisher closed');const queued=this.pending.has(file);this.pending.set(file,{text:JSON.stringify(data,null,2)});if(!queued)this.attempt(file);this.schedule();}
 attempt(file){const row=this.pending.get(file);if(!row)return;try{this.io.writeFileSync(file+'.tmp',row.text);this.io.renameSync(file+'.tmp',file);this.pending.delete(file);}catch(e){this.failures++;this.lastError={file,code:e.code||'ERROR',message:e.message,at:new Date().toISOString()};}}
 schedule(){if(this.closed||this.timer||!this.pending.size)return;this.timer=setTimeout(()=>{this.timer=null;for(const file of [...this.pending.keys()])this.attempt(file);this.schedule();},Math.min(this.maxRetryMs,this.retryMs));this.timer.unref?.();}
 status(){return {pending:this.pending.size,failures:this.failures,lastError:this.lastError};}
 async close(timeoutMs=5000){const end=Date.now()+timeoutMs;while(this.pending.size&&Date.now()<end){for(const file of [...this.pending.keys()])this.attempt(file);if(this.pending.size)await new Promise(r=>setTimeout(r,this.retryMs));}this.closed=true;clearTimeout(this.timer);this.timer=null;return this.status();}
}
module.exports={SnapshotPublisher};
