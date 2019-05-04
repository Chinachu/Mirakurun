FROM node:10-alpine

LABEL maintainer="Yuki KAN <re@pixely.jp>"

ENV DOCKER=YES

COPY . /tmp/src/

RUN set -eux \
 && (cd /tmp/src; npm i) \
 && (cd /tmp/src; npm run build) \
 && (cd /tmp/src; npm i -g --production --unsafe-perm $(npm pack)) \
 # cleanup
 && npm cache clean --force \
 && rm -rf /tmp/*

WORKDIR /usr/local/lib/node_modules/mirakurun/
EXPOSE 40772
CMD [ "npm", "start" ]
