## Service discovery designed for Docker Swarm cluster with multi-host networking.

This is lightweight recursive DNS server with Docker events monitor. You can query for actual IP information using _--name_ or _--net-alias_ of container. Supports Docker overlay networks with multiple records for one _--net-alias_.  Main purpose is - API Gateway with load-balancing for microservice architecture, makes possible to use many equal microservices by one name. 

To start service enter, for example: `docker run -d -p 53:53/udp nordluf/swarm-discovery http://10.0.2.4:4000`  where _10.0.2.4_ is IP of Swarm manager and _4000_ is exposed claster port. 
**IMPORTANT**  you need explicitly specify port exposing. And you need to specify _/udp_ modifier, because, by default, Docker exposes tcp ports. 
**IMPORTANT** don't add swarm-discovery container inside overlay network without port exposing - otherwise DNS will not be available. Internal Docker resolver trying to reach DNS server specified with _--dns_ option outside any overlay networks - so you need your instance of swarm discovery to be available from host node. 

After that you can start all others containers like this: `docker -H :4000 run -d --net=overlay-network --net-alias=nginxalias --dns=10.0.2.2  nginx` where _10.0.2.2_ is IP of node where swarm-discovery starts. From inside containers both regular DNS resolving and service discovery will be available.

If you starts some other containers with same _--net-alias_ name, you can then use this alias to connect one of them. For example: `$ curl http://nginxalias.overlay-network.discovery/main.php` will get /main.php from one of the started container (you wouldn't know which one).

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
    --dns-resolver <host>  Forward recursive questions to this resolver. Default 8.8.8.8
    --dns-timeout <num>    Resolve timeout in ms for recursive queries. Default 500ms
    --dns-bind <ip>        Bind DNS server for this address
    --network <name>       Multi-host default network name
```
