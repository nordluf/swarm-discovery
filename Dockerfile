FROM mhart/alpine-node:base
MAINTAINER Kruglov Evgeny <evgeny.kruglov@kairion.de>

WORKDIR /srv/www/app
COPY ./node_modules ./node_modules
COPY ./server.js ./
ENTRYPOINT ["node","server.js"]
#ENTRYPOINT ["/bin/sh"]

