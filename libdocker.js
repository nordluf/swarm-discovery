"use strict";
const _ = require('lodash');
const Promise = require('bluebird');
const isc = require('ip-subnet-calculator');
const strg = require('./libstorage.js');
const fs = require('fs');
let debug = ()=> 1; // Crap hack to reduce dependencies if we don't need them

let docker; // Docker management object
let dockerId; // Our docker id
let dockerName = '';
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
          .tap(data=> {
            let tmp = data.Name && data.Name.split('/');
            if (!tmp || !tmp[1]) {
              throw new Error('Docker container name not exists: ' + data.Name);
            }
            dockerName = tmp[1];
          })
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
    console.error("Disconnected from docker api. Restarting...");
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

function waitDisconnect(netId, netName) {
  // implementing the lo-o-ong way of disconnecting
  let netObj = docker.getNetwork(netId);
  let ownObj = docker.getContainer(dockerId);

  function localDisconnect(msg404) {
    return Promise.fromCallback(cb=>netObj.disconnect({Container: dockerName, Force: true}, cb))
      .catch(err=> {
        if (err.statusCode == 404) {
          console.error('Disconnect error: ' + msg404);
        } else {
          throw err;
        }
      }).delay(5000).return(false);
  }
  function props(){
    return Promise.props({
      net: Promise.fromCallback(cb=>netObj.inspect(cb)),
      obj: Promise.fromCallback(cb=>ownObj.inspect(cb))
    });
  }

  return Promise.resolve(Promise.fromCallback(cb=>netObj.inspect(cb)))
    .then(net=> {
      if (net.Containers[dockerId]) {
        return localDisconnect(`Data for the network ${netName} [${netId}] is inconsistent. Well, let's continue anyway.`);
      }
      console.error(`Swarm-discovery actually not connected to the network ${netName} [${netId}].`);
      return true;
    })
    .then(disconnected=> {
      if (disconnected){
        return;
      }
      let ptmt;
      let mainTmt=Date.now();

      return Promise.resolve()
        .then(function callMe() {
          return props().then(props=> {
            if (Date.now() - mainTmt > 6e4) {
              console.error(`Process of disconnectig has been running for 60s. Probably, there are some problems. Restarting..`);
              process.exit();
            } else if (props.net.Containers[dockerId] && props.obj.NetworkSettings.Networks[netName]) {
              //console.log(`Waiting for disconnecting from ${netName} [${netId}]...`);
              return Promise.resolve().delay(5e3).then(callMe);
            }
            ptmt=Date.now();
          })
        })
        .then(function callMe() {
          return props().then(props=> {
            if (!props.net.Containers[dockerId] && !props.obj.NetworkSettings.Networks[netName]) {
              // Disconnected successfully
              console.log(`Initially disconnected from the network ${netName} [${netId}]`);
              return true;
            } else if (Date.now() - mainTmt > 3e4) {
              console.error(`Swarm-discovery still looks connected to the network ${netName} [${netId}] after 30s`);
              if (!props.net.Containers[dockerId]){
                console.error('But, probably, we can try to resolve it later.');
                return true;
              }
              console.error('So, swarm-discovery restarting...');
              process.exit();
            } else if (Date.now() - ptmt > 1e4) {
              // We are waiting too long. Let's try again
              ptmt = Date.now();
              console.error(`Swarm-discovery still connected to the network ${netName} [${netId}]. Trying to disconnect again... `);
              return localDisconnect(`Data for the network ${netName} [${netId}] is inconsistent. Let's continue anyway.`)
                .catch(err=>{
                  if (err.statusCode == 500 && err.message.trim()==`(HTTP code 500) server error - container ${dockerId} is not connected to the network`) {
                    console.error(`Got 500 for disconnecting ${netName} [${netId}]. Yes, I know, funny, but probably - disconnected.`);
                    return true;
                  }
                  throw err;
                })
                .then(res=>res?true:callMe());
            } else {
              //console.error(`Data for the network ${netName} [${netId}] is inconsistent - net: ${!!props.net.Containers[dockerId]}, own: ${!!props.obj.NetworkSettings.Networks[netName]}. Waiting for some seconds...`);
              return Promise.resolve().delay(3e3).then(callMe);
            }
          })
        })
    });
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