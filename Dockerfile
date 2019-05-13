FROM node:10.15.3-alpine
ENV DOCKER=YES
ADD . /tmp/src
RUN set -eux && \
    (cd /tmp/src; \
     npm install && \
     npm run build && \
     npm install -g --production --unsafe-perm $(npm pack)) && \
    npm cache clean --force && \
    rm -rf /tmp/*
WORKDIR /usr/local/lib/node_modules/mirakurun
CMD [ "npm", "start" ]
EXPOSE 40772 41772
