"use strict";
const _ = require('lodash');
const commander = require('commander');

// :TODO add settings based on env vars and arguments
commander
  .version('0.0.1')
  .usage('[OPTIONS] [ENDPOINT]:[PORT]')
  .option('--debug', 'Logging more information')
  .option('--dns-logs', 'Logging dns queries information')
  .option('--dns-cached-logs', 'Logging cached dns queries information')
  .option('--dns-resolver <host>', 'Forward recursive questions to this resolver. Default 8.8.8.8')
  .option('--dns-timeout <num>', 'Resolve timeout in ms for recursive queries. Default 2500ms')
  .option('--dns-bind <ip>', 'Bind DNS server for this address')
  .option('--network <name>', 'Multi-host default network name')
  .option('--tld <tld>', 'TLD instead of .discovery')
  .parse(process.argv);

let docker;
if (commander.args[0]) {
  // so we can use http://apiurl:port
  if (commander.args[0].match(/:\d+$/)) {
    let tmp = commander.args[0].lastIndexOf(':');
    commander.args[1] = commander.args[0].slice(tmp + 1);
    commander.args[0] = commander.args[0].slice(0, tmp);
  }

  docker = new require('dockerode')({host: commander.args[0], port: commander.args[1] || 2375});
} else {
  docker = new require('dockerode')();
}

const emitter = new (require('docker-events'))({docker});
const ndns = require('native-dns');
const server = ndns.createServer();
let server_done = false;

let nodes = {};
let ips = {};

emitter.on("connect", function () {
  debug("Connected to docker api.");
  server_done = server_done || server.serve(53, commander.dnsBind || '0.0.0.0') || true;

  docker.listContainers({}, function (err, data) {
    if (err) {
      console.error(err.message);
      return;
    }
    data.map(i=>addOne(i.Id, (Date.now() - 1e3) * 1e6));
  });
});
emitter.on("disconnect", function () {
  console.error("Disconnected from docker api. Reconnecting.");
  nodes = {};
});

emitter.on('error', function (err) {
  console.error(err.message);
  process.exit();
});

emitter.on("start", function (message) {
  addOne(message.id, message.timeNano);
  debug(`Container started: ${message.id}`);
});
emitter.on("die", function (message) {
  removeOne(message.id, message.timeNano);
  debug(`Container died: ${message.id}`);
});
emitter.on("pause", function (message) {
  removeOne(message.id, message.timeNano);
  debug(`Container paused: ${message.id}`);
});
emitter.on("unpause", function (message) {
  addOne(message.id, message.timeNano);
  debug(`Container unpaused: ${message.id}`);
});

emitter.start();

server.on('request', function (req, res) {
  const reqType = ndns.consts.QTYPE_TO_NAME[req.question[0].type];
  if (reqType != 'A' && reqType != 'AAAA') {
    return dnsProxy(req, res);
  }

  let name = req.question[0].name.toLowerCase().split('.');
  if (name.length == 1 || name.length > 3) {
    return dnsProxy(req, res);
  }
  if (name.slice(-1)[0] != (commander.tld || 'discovery')) {
    return dnsProxy(req, res);
  }

  if (reqType == 'AAAA'){
    return res.send();
  }

  if (name.length == 2) {
    if (commander.network) {
      if (ips[commander.network] && ips[commander.network][name[0]]) {
        return doRet(ips[commander.network][name[0]], res, req);
      }
    }
  } else {
    if (ips[name[1]] && ips[name[1]][name[0]]) {
      return doRet(ips[name[1]][name[0]], res, req);
    }
  }

  let vals = _.find(nodes, {name: name[0]});
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
    return doRet(vals.ip, res, req);
  }

  return res.send();
});

function doRet(obj, res, req) {
  res.answer.push(ndns['A']({
    name: req.question[0].name,
    address: obj instanceof Object ? obj.ip[(obj.p > obj.ip.length - 1 && (obj.p = 0)) || obj.p++] : obj,
    ttl: 0
  }));
  res.send();
}

server.on('error', dnsErrorHandler);
server.on('socketError', dnsErrorHandler);
server.on('close', dnsErrorHandler);

function addOne(id, nt) {
  docker.getContainer(id).inspect({}, function (err, data) {
    if (err) {
      console.error(`Error ${err.statusCode}: '${err.reason}' for container ${id}`);
      return;
    }
    if (!data || !data.State || !data.State.Running) {
      console.error(`Container ${id} not running`);
      return;
    }
    if (data.State.Paused) {
      console.error(`Container ${id} paused`);
      return;
    }

    let ip = null;
    nodes[id] = {
      name: data.Name.slice(1).toLowerCase(),
      netNames: _.mapValues(data.NetworkSettings.Networks, 'Aliases'),
      binds: _(data.NetworkSettings.Ports).map(v=>v && v.map(v1=>(ip = v1.HostIp) + ':' + v1.HostPort)).flatten().compact().value(),
      ips: _.mapValues(data.NetworkSettings.Networks, 'IPAddress'),
      added: nt
    };
    nodes[id].ip = ip;

    _.reduce(nodes[id].netNames, (c, v, k)=>(ips[k] || (ips[k] = {})) && v && v.forEach(i=>
      (ips[k][i] || (ips[k][i] = {ip: [], p: 0})) && ips[k][i].ip.push(nodes[id].ips[k]))
      , 0);

    console.log(`Container ${nodes[id].name} added`);
  });
}

function removeOne(id, nt) {
  if (!nodes[id]) {
    console.error(`Container ${id} not exists.`);
    return;
  }
  if (nodes[id].added >= nt) {
    console.error(`Some action with ${id} already happened.`);
    return;
  }
  const tmp = nodes[id].name;

  _.reduce(nodes[id].netNames, (c, v, k)=>v && v.forEach(i=>
    !ips[k][i].ip.splice(ips[k][i].ip.indexOf(nodes[id].ips[k]), 1) ||
    ips[k][i].ip.length || !(delete ips[k][i]) ||
    Object.keys(ips[k]).length || (delete ips[k])
  ), 0);

  delete nodes[id];
  console.log(`Container ${tmp} removed`);
}

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
}
function fillReq(res, answer, req) {
  res.answer.push(...answer.answer);
  res.authority.push(...answer.authority);
  res.additional.push(...answer.additional);
  res.header = answer.header;
  res.header.id = req.header.id;
}

function dnsErrorHandler(err) {
  console.error(err.message);
  debug(err.stack);
  process.exit();
}
function debug(msg) {
  commander.debug && console.warn(msg);
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

process.on('SIGTERM', process.exit);
process.on('SIGINT', process.exit);