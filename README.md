## Service discovery designed for Docker Swarm cluster with multi-host networking.

This is lightweight forwarding DNS server with Docker events monitor. You can query for actual IP information using _--name_ or _--net-alias_ of container. Supports Docker overlay networks with multiple records for one _--net-alias_.  Main purpose is - API Gateway with load-balancing for microservice architecture, makes possible to use many equal microservices by one name. Of course, you can use it without overlay networks, only with single Docker.

Use case. You can have many Docker multihost networks (for example NW1, NW2) and many microservices in them (ms-js1 and ms-js2 in NW1, ms-php1 and ms-php2 in NW2). For each microservice you have more than one container, so you need to know how to reach other. For example - from ms-js1 ask ms-js2 for current user information. With swarm-discovery you need to do next steps to implement this:
1. Start swarm-discovery exposing 53/udp port. Like this: `docker run -v /var/run/docker.sock:/var/run/docker.sock --net=host -d  nordluf/swarm-discovery --dns-bind 172.17.0.1`
2. Start all microservices with `--dns 172.17.0.1 --net-alias <name>`. Like this: `docker run -d --net NW1 --net-alias ms-js1 --dns=172.17.0.1 nodeContainer`
3. Use DNS-based service discovery in your microservices. For example, to reach ms-js2 from ms-js1 with curl: `curl http://ms-js2.discovery/user/info`

If you have more than one ms-js2 instances each request goes to the next instance. New containers will be available with their net-aliases ASAP, and dissapears right after stopping/removing.

### Usage
To start service enter, for example: `docker run -d --net=host nordluf/swarm-discovery --dns-bind 172.17.0.1 http://10.0.2.4:4000` where _10.0.2.4_ is IP of Swarm manager and _4000_ is exposed claster port.

**IMPORTANT**  you need explicitly specify port exposing. And you need to specify _/udp_ modifier, because, by default, Docker exposes tcp ports.

**IMPORTANT**  you need to set --net=host for swarm-discovery container if you want auto-network recognition to work, otherwise you can use only full name or names setted with deafult network.

**IMPORTANT** don't add swarm-discovery container inside overlay network without port exposing - otherwise DNS will not be available. Internal Docker resolver trying to reach DNS server specified with _--dns_ option outside any overlay networks - so you need your instance of swarm discovery to be available from host node. 

After that you can start all others containers like this: `docker -H :4000 run -d --net=overlay-network --net-alias=nginxalias --dns=10.0.2.2  nginx` where _10.0.2.2_ is IP of node where swarm-discovery starts. From inside containers both regular DNS resolving and service discovery will be available.

If you starts some other containers with same _--net-alias_ name, you can then use this alias to connect one of them. For example: `$ curl http://nginxalias.overlay-network.discovery/main.php` will get /main.php from one of the started container (new IP each request).

DNS names types:
_net-alias-container-name.overlay-network-name.discovery_ - returns A records with IP's from _overlay-network-name_ 
_container-name.discovery_ - returns A record with IP of node and full list of exposed ports in SRV record 

Also, you can specify default overlay network name with _--network overlay-network-name_ and for this network use shorter name: _net-alias-container-name.discovery_

All queries not ending with _.discovery_ will be forwarded to 8.8.8.8 , or to the DNS server specified with _--dns-resolver_

### Command line options
```
  Usage:  [OPTIONS] [ENDPOINT]:[PORT]

  Options:

    -h, --help             output usage information
    -V, --version          output the version number
    --debug                Logging more information
    --dns-logs             Logging dns queries information
    --dns-cached-logs      Logging cached dns queries information
    --dns-resolver <host>  Forward recursive questions to this resolver. Default 8.8.8.8
    --dns-timeout <num>    Resolve timeout in microseconds for recursive queries. Default 2500ms
    --dns-bind <ip>        Bind DNS server for this address
    --network <name>       Multi-host default network name
    --tld <tld>            TLD instead of .discovery
```
