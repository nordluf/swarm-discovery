"use strict";
const _=require('lodash');
const commander=require('commander');

// :TODO add settings based on env vars and arguments
commander
  .version('0.0.1')
  .usage('[OPTIONS] [ENDPOINT]:[PORT]')
  .option('--debug','Logging more information')
  .option('--dns-logs','Logging dns queries information')
  .option('--dns-resolver <host>','Forward recursive questions to this resolver. Default 8.8.8.8')
  .option('--dns-timeout <num>','Resolve timeout in ms for recursive queries. Default 500ms')
  .option('--dns-bind <ip>','Bind DNS server for this address')
  .option('--network <name>','Multi-host default network name')
  .parse(process.argv);

let docker;
if (commander.args[0]) {
  // so we can use http://apiurl:port
  if (commander.args[0].match(/:\d+$/)){
    let tmp=commander.args[0].lastIndexOf(':');
    commander.args[1]=commander.args[0].slice(tmp+1);
    commander.args[0]=commander.args[0].slice(0,tmp);
  }

  docker = new require('dockerode')({host: commander.args[0],port:commander.args[1]||2375});
} else {
  docker = new require('dockerode')();
}

const emitter = new (require('docker-events'))({docker});
const dns=require('native-dns');
const server = dns.createServer();

const nodes={};

emitter.on("connect", function() {
  debug("Connected to docker api.");
  server.serve(53,commander.dnsBind || '0.0.0.0');

  docker.listContainers({},function(err,data){
    if (err){
      console.error(err.message);
      return;
    }
    data.map(i=>addOne(i.Id,(Date.now()-1e3)*1e6));
  });
});
emitter.on("disconnect", function() {
  // :TODO What can I do here?
  console.error("Disconnected from docker api. Reconnecting.");
});

emitter.on('error',function(err){
  console.error(err.message);
});

emitter.on("start", function(message) {
  addOne(message.id,message.timeNano);
  debug(`Container started: ${message.id}`);
});
emitter.on("die", function(message) {
  removeOne(message.id,message.timeNano);
  debug(`Container died: ${message.id}`);
});
emitter.on("pause", function(message) {
  removeOne(message.id,message.timeNano);
  debug(`Container paused: ${message.id}`);
});
emitter.on("unpause", function(message) {
  addOne(message.id,message.timeNano);
  debug(`Container unpaused: ${message.id}`);
});

emitter.start();

server.on('request', function (req, res) {
  if (!~_.indexOf(['A','AAAA'],dns.consts.QTYPE_TO_NAME[req.question[0].type])){
    return dnsProxy(req,res);
  }

  let name=req.question[0].name.toLowerCase().split('.');
  if (name.length==1 || name.length>3){
    return dnsProxy(req,res);
  }
  if (name.slice(-1)[0]!='discovery'){
    return dnsProxy(req,res);
  }

  let vals=[]
  if (name.length==3){
    vals=_.reduce(nodes,(o,v)=>~_.indexOf(v.netNames[name[1]],name[0]) && o.push(v.ips[name[1]]) && false || o,[]);
  } else {
    if (commander.network){
      vals=_.reduce(nodes,(o,v)=>
        ~_.indexOf(v.netNames[commander.network],name[0]) && o.push(v.ips[commander.network]) && false || o
        ,[]);
    }
    if (!vals.length){
      vals=_.find(nodes,{name:name[0]});
      if (vals && vals.ip){
        _.forEach(vals.binds,v=>{
          v=v.split(':');
          res.additional.push(dns.SRV({
            priority:0,
            weight:0,
            port: v[1],
            target:v[0],
            name: req.question[0].name,
            ttl:0
          }))
        });
        vals=[vals.ip];
      } else {
        vals=[];
      }
    }
  }

  _.shuffle(vals).forEach(v=>res.answer.push(dns.A({
    name: req.question[0].name,
    address: v,
    ttl: 0,
  })));
  return res.send();
});

server.on('error', dnsErrorHandler);
server.on('socketError', dnsErrorHandler);
server.on('close',dnsErrorHandler);

function addOne(id,nt){
  docker.getContainer(id).inspect({},function(err,data){
    if (err){
      console.error(`Error ${err.statusCode}: '${err.reason}' for container ${id}`);
      return;
    }
    if (!data || !data.State || !data.State.Running){
      console.error(`Container ${id} not running`);
      return;
    }
    if (data.State.Paused){
      console.error(`Container ${id} paused`);
      return;
    }

    let ip=null;
    nodes[id]={
      name:data.Name.slice(1).toLowerCase(),
      netNames:_.mapValues(data.NetworkSettings.Networks,'Aliases'),
      binds: _(data.NetworkSettings.Ports).map(v=>v&&v.map(v1=>(ip=v1.HostIp)+':'+v1.HostPort)).flatten().compact().value(),
      ips:_.mapValues(data.NetworkSettings.Networks,'IPAddress'),
      added: nt
    };
    nodes[id].ip=ip;
    console.log(`Container ${id} added`);
  });
}

function removeOne(id,nt){
  if (!nodes[id]){
    console.error(`Container ${id} not exists.`);
    return;
  }
  if (nodes[id].added>=nt){
    console.error(`Some action with ${id} already happened.`);
    return;
  }
  delete nodes[id];
  console.log(`Container ${id} removed`);
}

function dnsProxy(req,res){
  let start=Date.now();
  let proxy=dns.Request({
    question: req.question[0],
    server: { address: commander.dnsReslover || '8.8.8.8', port: 53, type: 'udp' },
    timeout: commander.dnsTimeout || 500,
  });

  proxy.on('timeout', function () {
    console.warn(`Timeout in making request for ${req.question[0].name} after ${Date.now()-start}ms`);
  });
  proxy.on('message', function (err, answer) {
    res.answer.push(...answer.answer);
    res.authority.push(...answer.authority);
    res.additional.push(...answer.additional);
  });
  proxy.on('end', function () {
    res.send();
    commander.dnsLogs && console.log(
      `DNS type ${dns.consts.QTYPE_TO_NAME[req.question[0].type]} for ${req.question[0].name} takes ${Date.now()-start}ms`
    );
  });
  proxy.send();
}

function dnsErrorHandler(err) {
  console.error(err.message);
  debug(err.stack);
  process.exit();
}
function debug(msg){
  commander.debug && console.warn(msg);
}

process.on('SIGTERM', process.exit);
process.on('SIGINT', process.exit);