"use strict";
const _ = require('lodash');
const commander = require('commander');
const Promise = require('bluebird');
const fs = require('fs');
const isc = require('ip-subnet-calculator');
const strg = require('./libstorage.js');

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

let docker; // Docker management object
let dockerId; // Our docker id
let server_done = false;

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

  docker = new require('dockerode')({host: commander.args[0], port: commander.args[1] || 2375});
} else {
  docker = new require('dockerode')();
}

const emitter = new (require('docker-events'))({docker}); // Docker events listener
const ndns = require('native-dns'); // Native DNS object
const server = ndns.createServer();

emitter.on("connect", function () {
  debug("Connected to docker api.");
  let props = {
    containers: Promise.fromCallback(cb=>docker.listContainers({}, cb))
      .then(data=>data.map(i=>addOne(i.Id).reflect()))
      .all()
  };
  if (!commander.noAutoNetworks) {
    props.networks = Promise.fromCallback(cb=>docker.listNetworks({}, cb))
      .filter(i=>i && i.Driver == 'overlay');
    props.did = Promise.fromCallback(cb=>fs.readFile('/proc/1/cpuset', {encoding: 'ascii'}, cb));
  }
  Promise.props(props)
    .delay(1000)
    .then(i=> {
      if (commander.noAutoNetworks) {
        return;
      }
      if (!i.did || !(dockerId = /^\/docker\/([0-9a-f]+)\s*$/gm.exec(i.did))) {
        console.log('swarm-discovery started not as Docker container');
        commander.noAutoNetworks = true;
        return;
      }
      dockerId = dockerId[1];
      console.log(`Swarm-discovery docker id: ${dockerId}`)

      return Promise.fromCallback(cb=>docker.getContainer(dockerId).inspect(cb))
        .catch(err=> {
          console.error('docker.getContainer error');
          console.error(err);
          process.exit();
        })
        .then(data=> {
          return _.map(data.NetworkSettings.Networks, net=>
            !_.find(i.networks, {Id: net.NetworkID}) ? false :
              Promise.fromCallback(cb=>docker.getNetwork(net.NetworkID).disconnect({Container: dockerId, Force: true}, cb))
          );
        })
        .catch(err=> {
          console.error('docker.network().disconnect error');
          console.error(err);
          process.exit();
        })
        .all()
        .then(()=>Promise.all(_.map(i.networks, net=>connect2Net(net.Id, true))))
        .catch(err=> {
          console.error('docker.network().connect error');
          console.error(err);
          process.exit();
        })
        .then(refillOwnIp)
        .catch(err=> {
          console.error('refillOwnIp error');
          console.error(err.json);
          console.error(err);
          commander.noAutoNetworks = true;
          process.exit();
        })
    })
    .then(()=> {
      if (commander.noAutoNetworks) {
        console.log('Auto network recognition disabled.');
      }

      server_done = server_done || server.serve(53, commander.dnsBind || '0.0.0.0') || true;
      console.log("Server is starting...");
    })
    .catch(err=> {
      console.error('Common startup error');
      console.error(err.message);
      console.error(err);
      process.exit();
    });
});
emitter.on("disconnect", function () {
  console.error("Disconnected from docker api. Reconnecting.");
});

emitter.on('error', function (err) {
  console.error('Emmiter error');
  console.error(err.message);
  console.error(err);
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

if (!commander.noAutoNetworks) {
  emitter.on("_message", function (msg) {
    if (!msg || msg.Type != 'network' || !msg.Actor || !msg.Actor.Attributes) {
      return;
    }

    if (msg.Action == 'create') {
      if (msg.Actor.Attributes.type == 'overlay') {
        connect2Net(msg.Actor.ID);
      }
    } else if (msg.Action == 'destroy') {
      disconnect2Net(msg.Actor.ID, true);
    } else if (msg.Action == 'disconnect') {
      if (msg.Actor.Attributes.container == dockerId) {
        disconnect2Net(msg.Actor.ID);
      }
    }
  });
}

emitter.start();

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
      return obj?doRet(obj, res, req, reqType):false;
    };

    if (!commander.noAutoNetworks) {
      let net = strg.getNetByIp(req.address.address);
      if (net && tryIps(net.name)){
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

function addOne(id, nt) {
  return Promise.fromCallback(cb=>docker.getContainer(id).inspect({}, cb))
    .then(data=> {
      if (!data || !data.State || !data.State.Running) {
        console.error(`Container ${id} not running`);
        return;
      }
      if (data.State.Paused) {
        console.error(`Container ${id} paused`);
        return;
      }
      let node = strg.addNode(data,nt);

      debug(`Container ${node.name} added`);
    })
    .catch(err=> {
      console.error(`Error ${err.statusCode}: '${err.reason}' for container ${id}`);
      console.error(err);
    });
}
function removeOne(id, nt) {
  let node = strg.getNode(id);
  if (!node) {
    console.error(`Container ${id} not exists.`);
    return;
  }
  if (node.added >= nt) {
    console.error(`Some action with ${id} already happened.`);
    return;
  }

  strg.removeNode(id);
  debug(`Container ${node.name} removed`);
}

function connect2Net(netId, skip) {
  let obj = docker.getNetwork(netId);
  let netName;
  let lastIp = null;
  return Promise.fromCallback(cb=>obj.inspect(cb))
    .then(nets=> {
        netName = nets.Name;
        return strg.prepareNetworks(nets);
      }
    )
    .tap((nets)=>Promise.fromCallback(cb=>obj.connect({
      Container: dockerId,
      EndpointConfig: {
        IPAMConfig: {
          IPv4Address: isc.toString(nets[0].ipHigh - 1 - (commander.skipIp || 0))
        }
      }
    }, cb)))
    .then(nets=> {
      strg.addNetwork(nets);

      debug(`Connected to a network ${nets[0].name}`);
    })
    .then(()=>skip ? true : refillOwnIp())
    .catch(err=> {
      console.error(`Auto network recognition and in-network DNS for network ${netName} [${netId}] disabled:`);
      console.error(err);
    });
}
function disconnect2Net(netId, remove) {
  strg.removeNetwork(netId);
  if (!remove) {
    debug(`Disconnected from a network ${netId}`);
  }
}
function refillOwnIp() {
  return Promise.fromCallback(cb=>docker.getContainer(dockerId).inspect(cb))
    .then(data=> {
      _.each(data.NetworkSettings.Networks, net=> {
        strg.setNetworkIp(net.NetworkID,net.IPAddress);
      });
    })
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
  pcache[key].catch(()=>{});
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

function showLogOnExit(){
  console.error('Recieve signal. Exiting...');
  process.exit()
}
process.on('SIGTERM', showLogOnExit);
process.on('SIGINT', showLogOnExit);