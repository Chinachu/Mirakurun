FROM node:10.15.3-alpine AS build
WORKDIR /app
ENV DOCKER=YES
ADD . .
RUN npm install && \
    npm run build && \
    mv $(npm pack) mirakurun.tgz  # strip the version string

FROM node:10.15.3-alpine
ENV DOCKER=YES
COPY --from=build /app/mirakurun.tgz /tmp/
RUN npm install -g --production --unsafe-perm /tmp/mirakurun.tgz && \
    npm cache clean --force && \
    rm -rf /tmp/*
WORKDIR /usr/local/lib/node_modules/mirakurun
CMD [ "npm", "start" ]
EXPOSE 40772 41772
