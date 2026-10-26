'use strict';
// TShark boolean fields vary by output/version: this capture uses True/False.
function captureFlag(value){
 if(value==='1'||value==='True'||value==='true')return true;
 if(value==='0'||value==='False'||value==='false')return false;
 throw Error('Missing or unsupported TCP flag representation');
}
function connectionBoundary(packet){
 const flags=[captureFlag(packet.syn),captureFlag(packet.fin),captureFlag(packet.rst)];
 return flags.some(Boolean);
}
module.exports={captureFlag,connectionBoundary};
