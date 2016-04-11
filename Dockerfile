FROM mhart/alpine-node:latest
MAINTAINER Kruglov Evgeny <ekruglov@gmail.com>
EXPOSE 53

WORKDIR /srv/www/app
COPY ./server.js ./package.json ./
RUN npm install && rm -rf /root/.npm
ENTRYPOINT ["node","server.js"]
