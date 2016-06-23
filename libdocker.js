"use strict";
const _ = require('lodash');
const Promise = require('bluebird');
const isc = require('ip-subnet-calculator');
const strg = require('./libstorage.js');
const fs = require('fs');
let debug=()=>{}

let docker; // Docker management object
let dockerId; // Our docker id
let server_done = false;
let emitter;
let commander;
let startupCallback;

function init(cmd,opts) {
  commander=cmd;
  if (commander.debug) {
    debug = require('./libdebug.js')(true);
  }

  docker = new require('dockerode')(opts);
  emitter= new (require('docker-events'))({docker}); // Docker events listener

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
}

function initAutoNetwork(){
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

function start(cb){
  startupCallback=cb;
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
        strg.setNetworkIp(net.NetworkID, net.IPAddress);
      });
    })
}
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
      let node = strg.addNode(data, nt);

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


module.exports = {
  init,
  initAutoNetwork,
  start
};