FROM mhart/alpine-node:6
MAINTAINER Yuki KAN <re@pixely.jp>

WORKDIR /usr/src/app
ADD . .

RUN mkdir /etc/mirakurun \
    && cp ./config/*.yml /etc/mirakurun/ \
    && mkdir -p /var/db/mirakurun \
    && npm install \
    && npm run build

ENV SERVER_CONFIG_PATH=/etc/mirakurun/server.yml \
    TUNERS_CONFIG_PATH=/etc/mirakurun/tuners.yml \
    CHANNELS_CONFIG_PATH=/etc/mirakurun/channels.yml \
    SERVICES_DB_PATH=/var/db/mirakurun/services.json \
    PROGRAMS_DB_PATH=/var/db/mirakurun/programs.json

USER root
EXPOSE 40772
CMD [ "npm", "start" ]