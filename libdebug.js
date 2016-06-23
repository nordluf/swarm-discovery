"use strict";
module.exports=function(doDebug){
  return function (msg) {
    doDebug && console.warn(msg);
  }
}