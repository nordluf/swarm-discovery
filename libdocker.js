"use strict";
const _ = require('lodash');
const Promise = require('bluebird');
const isc = require('ip-subnet-calculator');
const strg = require('./libstorage.js');
const fs = require('fs');
let debug = ()=> 1;

let docker; // Docker management object
let dockerId; // Our docker id
let server_done = false;
let emitter;
let commander;
let startupCallback;

function init(cmd, opts) {
  commander = cmd;
  if (commander.debug) {
    debug = require('./libdebug.js')(true);
  }

  docker = new require('dockerode')(opts);
  emitter = new (require('docker-events'))({docker}); // Docker events listener

  emitter.on("connect", function () {
    debug("Connected to docker api.");
    let props = {
      containers: Promise.fromCallback(cb=>docker.listContainers({}, cb))
        .then(data=>data.map(i=>addOne(i.Id).reflect())).all()
    };
    if (!commander.noAutoNetworks) {
      props.networks = Promise.fromCallback(cb=>docker.listNetworks({}, cb))
        .filter(i=>i && i.Driver == 'overlay');
      props.did = Promise.fromCallback(cb=>fs.readFile('/proc/1/cpuset', {encoding: 'ascii'}, cb));
    }
    Promise.props(props)
      .then(props=> {
        if (commander.noAutoNetworks) {
          return;
        }
        if (!props.did || !(dockerId = /^\/docker\/([0-9a-f]+)\s*$/gm.exec(props.did))) {
          console.log('swarm-discovery started not as Docker container');
          commander.noAutoNetworks = true;
          return;
        }
        dockerId = dockerId[1];
        console.log(`Swarm-discovery docker id: ${dockerId}`);

        return Promise.fromCallback(cb=>docker.getContainer(dockerId).inspect(cb))
          .catch(err=> {
            console.error('docker.getContainer error');
            console.error(err);
            process.exit();
          })
          .then(data=>
            _.map(data.NetworkSettings.Networks, (net, netName)=>
              !_.find(props.networks, {Id: net.NetworkID}) ? false : [net.NetworkID, netName]
            ).filter(i=>i)
          )
          .mapSeries(net=>waitDisconnect(net[0], net[1]))
          .catch(err=> {
            console.error('docker.network().disconnect error');
            console.error(err);
            process.exit();
          })
          .return(props.networks)
          .mapSeries(net=>connect2Net(net.Id, true))
          // .then(()=>Promise.all(_.map(props.networks, net=>connect2Net(net.Id, true))))
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

        server_done = server_done || startupCallback && startupCallback() || true;
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
    process.exit()
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
      if (!server_done) {
        return;
      }
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
}

function start(cb) {
  startupCallback = cb;
  emitter.start();
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

      console.log(`Connected to a network ${netName} [${netId}]`);
    })
    .then(()=>skip ? true : refillOwnIp())
    .catch(err=> {
      console.error(`Auto network recognition and in-network DNS for network ${netName} [${netId}] disabled:`);
      console.error(err);
      process.exit();
    });
}
function disconnect2Net(netId, remove) {
  strg.removeNetwork(netId);
  console.log(`Disconnected from ${remove ? 'destroyed' : 'a'} network [${netId}]`);
}

function waitDisconnect(nid, name) {
  let nobj = docker.getNetwork(nid);
  let initTmt = Date.now();

  function localDisconnect(net, msg404) {
    return Promise.fromCallback(cb=>nobj.disconnect({Container: net.Containers[dockerId].Name, Force: true}, cb))
      .catch(err=> {
        if (err.statusCode == 404) {
          console.error(msg404);
        } else {
          throw err;
        }
      })
  }

  return Promise.resolve()
    .then(function callMe() {
      return Promise.fromCallback(cb=>nobj.inspect(cb))
        .then(net=> {
          if (net.Containers[dockerId]) {
            let initTmt = Date.now();
            return localDisconnect(net, `Data for the network ${name} [${nid}] is inconsistent. Well, let's continue anyway.`);
          } else if (Date.now() - initTmt > 1e4) {
            let initTmt = Date.now();
            console.error(`Swarm-discovery still not connected to the network ${name} [${nid}]. Let's pray that it could be resolved later, what else can we do?`);
            return true;
          }
          console.error(`Swarm-discovery actually not connected to the network ${name} [${nid}]. Waiting for a second...`);
          return Promise.resolve().delay(1000).then(callMe);
        })
    }).then(function callMe() {
      return Promise.fromCallback(cb=>nobj.inspect(cb))
        .then(net=> {
          if (!net.Containers[dockerId]) {
            let initTmt = Date.now();
            console.log(`Initially disconnected from the network ${name} [${nid}]`);
            return true;
          } else if (Date.now() - initTmt > 1e4) {
            let initTmt = Date.now();
            console.error(`Data for the network ${name} [${nid}] is inconsistent. Probably we have been disconnected.`);
            return true;
          }
          console.error(`Swarm-discovery still connected to the network ${name} [${nid}]. Trying to disconnect and check a second later... `);
          return Promise.resolve()
            .then(()=>localDisconnect(net, `Data for the network ${name} [${nid}] is inconsistent. But - still waiting...`))
            .delay(1000).then(callMe);
        })
    })
    .then(()=>setTimeout(()=> {
      console.error(`Swarm-discovery actually still connected to network ${name} [${nid}] after 10 seconds. Restarting...`);
      process.exit();
    }, 1e4))
    .then(function callMe(tmt) {
      return Promise.fromCallback(cb=>nobj.inspect(cb))
        .then(net=> {
          if (!net.Containers[dockerId]) {
            clearTimeout(tmt);
            return true;
          }
          console.error(`Swarm-discovery actually still connected to network ${name} [${nid}]. Waiting for a seconds...`);
          return Promise.resolve().delay(1000).then(()=>callMe(tmt));
        })
    })
}

function refillOwnIp() {
  return Promise.fromCallback(cb=>docker.getContainer(dockerId).inspect(cb))
    .then(data=> {
      _.each(data.NetworkSettings.Networks, net=> {
        strg.setNetworkIp(net.NetworkID, net.IPAddress);
      });
    })
}
function addOne(id, nt) {
  return Promise.resolve().then(()=>strg.getRemoveMark(id, nt) || Promise.fromCallback(cb=>docker.getContainer(id).inspect({}, cb)))
    .then(data=> {
      if (typeof data != 'object') {
        debug(`Container ${id} exited right after start`);
        return;
      }
      if (!data || !data.State || !data.State.Running) {
        debug(`Container ${id} not running`);
        strg.upRemoveMark(id, nt);
        return;
      }
      if (data.State.Paused) {
        console.error(`Container ${id} paused`);
        return;
      }
      let node = strg.addNode(data, nt);

      process.nextTick(()=>debug(`Container ${node.name}[${id}] added with IPs ` + JSON.stringify(node.ips)));
    })
    .catch(err=> {
      if (err.statusCode == 404) {
        strg.upRemoveMark(id, nt);
        debug(`Error 404: '${err.reason}' for container ${id}. Exited right after start?`);
        return;
      }
      console.error(`Error ${err.statusCode}: '${err.reason}' for container ${id}`);
      console.error(err);
    });
}
function removeOne(id, nt) {
  if (!strg.upRemoveMark(id, nt)) {
    return;
  }

  let node = strg.getNode(id);
  if (!node) {
    debug(`Container ${id} not exists. Nothing to remove.`);
    return;
  }
  if (node.added >= nt) {
    console.error(`Some action with ${node.name}[${id}] already happened.`);
    return;
  }

  strg.removeNode(id);
  debug(`Container ${node.name}[${id}] removed`);
}


module.exports = {
  init,
  start
};