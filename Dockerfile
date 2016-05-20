FROM mhart/alpine-node:latest
MAINTAINER Kruglov Evgeny <ekruglov@gmail.com>
EXPOSE 53/udp
ENV DEBUG=modem

WORKDIR /srv/www/app
COPY ./server.js ./package.json ./
RUN apk -U add python make g++ && npm install && rm -rf /root/.npm
ENTRYPOINT ["node","server.js"]