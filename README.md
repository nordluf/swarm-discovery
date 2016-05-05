## Service discovery designed for Docker Swarm cluster with multi-host networking.

This is a lightweight forwarding DNS server with a Docker events monitor. You can query for an actual IP information using _--name_ or _--net-alias_ of the container. It supports Docker overlay networks with multiple records for one _--net-alias_. The main function of it is: to be a service discovery with round-robin load-balancing for microservice architecture. It also makes possible to use many equal microservices with one name. Of course, you can use it without swarm overlay networks, only with a single Docker engine.

The use case: you can have many Docker multihost networks (for example NW1, NW2) and many microservices in them (for example ms-js1 and ms-js2 in NW1, ms-php1 and ms-php2 in NW2). You have more than one container for each microservice, and you need to know how to reach others. For example - from ms-js1 asks ms-js2 for getting current user information. If you use swarm-discovery you need to do next steps to implement this:
1. Start swarm-discovery. Like this: `docker -H tcp://192.168.200.100:4000 run -d nordluf/swarm-discovery 192.168.200.100:4000`
2. Create new overlay network `docker -H tcp://192.168.200.100:4000 network create -d overlay --subnet=10.0.10.0/24 msnet`
3. Start all microservices with `--dns 10.0.10.2 --net-alias <name>`. Like this: `docker tcp://192.168.200.100:4000 run -d --net NW1 --net-alias ms-js1 --dns=10.0.10.2 nodeImage`
4. Use DNS-based service discovery in your microservices. For example, to reach ms-js2 from ms-js1 with curl: `curl http://ms-js2.discovery/user/info`
5. You can use many different networks at the same time, so to reach ms-php1 from ms-php2 you can use `curl http://ms-php1.discovery/user/info` or, if you preffer long names, `curl http://ms-php1.NW2.discovery/user/info`

If you have more than one ms-js2 instances then each next request goes to the next instance. A new container will be available with its net-aliases ASAP, and the access will dissapear right after the container stops or removes.

### Usage
To start service enter, for example: `docker run -d nordluf/swarm-discovery http://10.0.2.4:4000` where _10.0.2.4_ is IP of Swarm manager and _4000_ is exposed claster port. After starting service will automatically join all overlay networks (existed or created), so you can use IP from internal network for name resolution in your microservices. 

After that you can start all others containers like this: `docker -H :4000 run -d --net=overlay-network --net-alias=nginxalias --dns=10.0.2.2  nginx` where _10.0.2.2_ is IP of node from internal network where swarm-discovery starts. From inside containers both regular DNS resolving and service discovery will be available.

If you starts some other containers with same _--net-alias_ name, you can then use this alias to connect one of them. For example: `$ curl http://nginxalias.overlay-network.discovery/main.php` will get /main.php from one of the started container (new IP each request).

DNS names types:
_net-alias-container-name.overlay-network-name.discovery_ - returns A records with IP's from _overlay-network-name_ 
_container-name.discovery_ - returns A record with IP of node from external network (or nothing, if there are no exposed ports) and full list of exposed ports in SRV record 

Also, you can specify default overlay network name with _--network overlay-network-name_ and for this network use shorter name: _net-alias-container-name.discovery_. 

Also, you can use short names with auto-network recognition feature. This works only if you query DNS with internal IP. To get the full list of connected networks and IP's of node inside them use `dig discovery @10.0.2.1` where 10.0.2.1 is the IP of node, doesn't matter - internal or external. 

All queries not ending with _.discovery_ (or TLD passed with --tld option) will be forwarded to 8.8.8.8, or to the DNS server specified with _--dns-resolver_

### Command line options
```
  Usage:  [OPTIONS] [ENDPOINT]:[PORT]

  Options:

    -h, --help                output usage information
    -V, --version             output the version number
    --debug                   Logging more information
    --dns-logs                Logging dns queries information
    --dns-cached-logs         Logging cached dns queries information
    --dns-resolver <host>     Forward recursive questions to this resolver. Default 8.8.8.8
    --dns-timeout <num>       Resolve timeout in microseconds for recursive queries. Default 2500ms
    --dns-bind <ip>           Bind DNS server for this address
    --network <name>          Multi-host default network name
    --skip-ip <num>           Skip <num> ip's from the end to auto-bind
    --tld <tld>               TLD instead of .discovery
    --no-auto-networks <tld>  Disable auto networks monitoring and recognition
```
