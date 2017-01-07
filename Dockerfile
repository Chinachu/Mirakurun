FROM node:6-onbuild
MAINTAINER Yuki KAN <re@pixely.jp>

RUN mkdir /etc/mirakurun
RUN cp ./config/*.yml /etc/mirakurun/
ENV SERVER_CONFIG_PATH /etc/mirakurun/server.yml
ENV TUNERS_CONFIG_PATH /etc/mirakurun/tuners.yml
ENV CHANNELS_CONFIG_PATH /etc/mirakurun/channels.yml

RUN mkdir -p /var/db/mirakurun
ENV SERVICES_DB_PATH /var/db/mirakurun/services.json
ENV PROGRAMS_DB_PATH /var/db/mirakurun/programs.json

RUN npm install
RUN npm run build

USER root
EXPOSE 40772
CMD [ "npm", "start" ]