"use strict";
const _ = require('lodash');
const commander = require('commander');
const Promise = require('bluebird');
const ndns = require('native-dns'); // Native DNS object
const strg = require('./libstorage.js');
const dckr = require('./libdocker.js');
let debug = ()=> {
};

// :TODO add settings based on env vars and arguments
commander
  .version('0.1.0')
  .usage('[OPTIONS] [ENDPOINT]:[PORT]')
  .option('--debug', 'Logging more information')
  .option('--dns-logs', 'Logging dns queries information')
  .option('--dns-cached-logs', 'Logging cached dns queries information')
  .option('--dns-resolver <host>', 'Forward recursive questions to this resolver. Default 8.8.8.8')
  .option('--dns-timeout <num>', 'Resolve timeout in microseconds for recursive queries. Default 2500ms')
  .option('--dns-bind <ip>', 'Bind DNS server for this address')
  .option('--network <name>', 'Multi-host default network name')
  .option('--skip-ip <num>', 'Skip <num> ip\'s from the end to auto-bind')
  .option('--tld <tld>', 'TLD instead of .discovery')
  .option('--no-auto-networks <tld>', 'Disable auto networks monitoring and recognition')
  .parse(process.argv);


if (commander.skipIp && commander.skipIp != parseInt(commander.skipIp)) {
  console.error('Error: --skip-ip has to be num');
  process.exit();
}
if (commander.args[0]) {
  // so we can use http://apiurl:port
  if (commander.args[0].match(/:\d+$/)) {
    let tmp = commander.args[0].lastIndexOf(':');
    commander.args[1] = commander.args[0].slice(tmp + 1);
    commander.args[0] = commander.args[0].slice(0, tmp);
  }

  dckr.init(commander,{host: commander.args[0], port: commander.args[1] || 2375})
} else {
  dckr.init(commander)
}

if (!commander.noAutoNetworks) {
  dckr.initAutoNetwork();
}
if (commander.debug) {
  debug = require('./libdebug.js')(true);
}

const server = ndns.createServer();
server.on('request', function (req, res) {
  res.timestamp = Date.now();
  const reqType = ndns.consts.QTYPE_TO_NAME[req.question[0].type];
  if (reqType != 'A' && reqType != 'AAAA') {
    return dnsProxy(req, res);
  }

  let name = req.question[0].name.toLowerCase().split('.');
  if (name.length > 3 || name.length == 1 && commander.noAutoNetworks) {
    return dnsProxy(req, res);
  }
  if (name.slice(-1)[0] != (commander.tld || 'discovery')) {
    return dnsProxy(req, res);
  }

  if (name.length == 1) {
    return ownIps(req, res);
  } else if (name.length == 2) {
    let tryIps = function (nm) {
      if (!nm) {
        return false;
      }
      let obj = strg.getObject(nm, name[0]);
      return obj ? doRet(obj, res, req, reqType) : false;
    };

    if (!commander.noAutoNetworks) {
      let net = strg.getNetByIp(req.address.address);
      if (net && tryIps(net.name)) {
        return;
      }
    }

    if (tryIps(commander.network)) {
      return;
    }

  } else {
    let obj = strg.getObject(name[1], name[0]);
    if (obj) {
      return doRet(obj, res, req, reqType);
    }
  }

  let vals = strg.getNodeByName(name[0]);
  if (vals && vals.ip) {
    _.forEach(vals.binds, v=> {
      v = v.split(':');
      res.additional.push(ndns.SRV({
        priority: 0,
        weight: 0,
        port: v[1],
        target: v[0],
        name: req.question[0].name,
        ttl: 0
      }))
    });
    return doRet(vals.ip, res, req, reqType);
  }

  return checkTime(res);
});

function doRet(obj, res, req, reqType) {
  res.answer.push(ndns['A']({
    name: req.question[0].name,
    address: obj instanceof Object ? obj.ip[(obj.p > obj.ip.length - 1 && (obj.p = 0)) || reqType == 'A' ? obj.p++ : obj.p] : obj,
    ttl: 0
  }));
  return checkTime(res);
}
function checkTime(res) {
  res.send();
  if (Date.now() - res.timestamp > 20) {
    console.warn(`Request ${res.question[0].name} takes ${Date.now() - res.timestamp}ms to complete!`);
  }

  return true;
}

function ownIps(req, res) {
  let net = strg.getNetByIp(req.address.address);
  if (net) {
    res.answer.push(ndns['A']({
      name: net.name + '.' + req.question[0].name,
      address: net.ip,
      ttl: 0
    }));
  } else {
    strg.getNetworks().forEach(net=>net.ip && res.answer.push(ndns['A']({
      name: net.name + '.' + req.question[0].name,
      address: net.ip,
      ttl: 0
    })));
  }
  return checkTime(res);
}

server.on('error', dnsErrorHandler);
server.on('socketError', dnsErrorHandler);
server.on('close', dnsErrorHandler);

dckr.start(()=>{
  return server.serve(53, commander.dnsBind || '0.0.0.0');
});

const reqObj = {
  question: {name: '0123456789012345678901234567890123456789', type: 28, class: 1},
  server: {address: commander.dnsReslover || '8.8.8.8', port: 53, type: 'udp'},
  timeout: commander.dnsTimeout || 2500
};
const cache = {};
const relcache = {};
const pcache = {};

function dnsProxy(req, res) {
  const start = Date.now();
  let key = req.question[0];
  key = key.class + '_' + key.type + '_' + key.name;
  if (cache[key]) {
    fillReq(res, cache[key], req);
    res.send();
    commander.dnsCachedLogs && console.log(
      `CACHED DNS type ${ndns.consts.QTYPE_TO_NAME[req.question[0].type]} for ${req.question[0].name} [${req.header.id}] takes ${Date.now() - start}ms`
    );
    return;
  }

  if (pcache[key]) {
    pcache[key].then(cachkey=> {
      fillReq(res, cachkey, req);
      res.send();
      commander.dnsCachedLogs && console.log(
        `PCACHED DNS type ${ndns.consts.QTYPE_TO_NAME[req.question[0].type]} for ${req.question[0].name} [${req.header.id}] takes ${Date.now() - start}ms`
      );
    }).catch(dnsProxy.bind(null, req, res));
    return;
  }

  pcache[key] = new Promise((resolve, reject)=> {
    reqObj.question = req.question[0];
    let proxy = ndns.Request(reqObj);

    proxy.on('timeout', function () {
      res.send();
      console.warn(`Timeout in making request for ${req.question[0].name} [${req.header.id}] after ${Date.now() - start}ms`);
      delete pcache[key];
      reject();
    });
    proxy.on('message', function (err, answer) {
      if (err) {
        res.send();
        console.error('Proxy error');
        console.error(err);
        delete pcache[key];
        return reject();
      }
      fillReq(res, answer, req);
      res.send();
      commander.dnsLogs && console.log(
        `DNS type ${ndns.consts.QTYPE_TO_NAME[req.question[0].type]} for ${req.question[0].name} [${req.header.id}] takes ${Date.now() - start}ms`
      );

      cache[key] = {
        answer: answer.answer,
        authority: answer.authority,
        additional: answer.additional,
        header: answer.header
      };
      delete pcache[key];
      resolve(cache[key]);

      let startid = start / 6e4 ^ 0;
      if (!relcache[startid]) {
        relcache[startid] = [key];
      } else {
        relcache[startid].push(key);
      }
    });
    //proxy.on('end', function (){
    //  //setTimeout(res.send.bind(res),10);
    //});
    proxy.send();
  });
  pcache[key].catch(()=> {
  });
}
function fillReq(res, answer, req) {
  res.answer.push(...answer.answer);
  res.authority.push(...answer.authority);
  res.additional.push(...answer.additional);
  res.header = answer.header;
  res.header.id = req.header.id;
}

function dnsErrorHandler(err) {
  console.error('DNS EH error');
  console.error(err.message);
  console.error(err.stack);
  console.error(err);
  process.exit();
}

setTimeout(function callMe() {
  const start = Date.now();
  let i = 0;
  for (let k in relcache) {
    i++;
    if (k < start / 6e4 - 1 ^ 0) {
      setImmediate(function () {
        const start = Date.now();
        let i = 0;
        relcache[k].forEach(key=> {
          delete cache[key];
          i++;
        });
        delete relcache[k];

        if (Date.now() - start > 10) {
          console.warn(`Garbage collector subroutine takes ${Date.now() - start}ms to remove ${i} records!`);
        } else {
          i && debug(`${i} cached records removed`);
        }
      });
    }
  }

  setTimeout(callMe, 6e4);
  if (Date.now() - start > 50) {
    console.warn(`Garbage collector takes ${Date.now() - start}ms for ${i} keys!`);
  }
}, 6e4);

function showLogOnExit() {
  console.error('Recieve signal. Exiting...');
  process.exit()
}
process.on('SIGTERM', showLogOnExit);
process.on('SIGINT', showLogOnExit);