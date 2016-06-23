FROM mhart/alpine-node:latest
MAINTAINER Kruglov Evgeny <ekruglov@gmail.com>
EXPOSE 53/udp
ENTRYPOINT ["node","server.js"]

WORKDIR /srv/www/app
COPY ./ ./

RUN npm install && rm -rf /root/.npm
