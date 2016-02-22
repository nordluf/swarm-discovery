FROM mhart/alpine-node:latest
MAINTAINER Kruglov Evgeny <evgeny.kruglov@kairion.de>
EXPOSE 53

WORKDIR /srv/www/app
COPY ./server.js ./package.json ./
RUN npm install
ENTRYPOINT ["node","server.js"]
