FROM mhart/alpine-node:base
MAINTAINER Kruglov Evgeny <evgeny.kruglov@kairion.de>
EXPOSE 53

WORKDIR /srv/www/app
COPY ./node_modules ./node_modules
COPY ./server.js ./
ENTRYPOINT ["node","server.js"]
