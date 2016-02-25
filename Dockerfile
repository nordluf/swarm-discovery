FROM mhart/alpine-node:latest
MAINTAINER Kruglov Evgeny <ekruglov@gmail.com>
EXPOSE 53

WORKDIR /srv/www/app
COPY ./server.js ./package.json ./
RUN npm install
ENTRYPOINT ["node","server.js"]
