FROM mhart/alpine-node:8
LABEL maintainer "Yuki KAN <re@pixely.jp>"

WORKDIR /usr/src/app
ADD . .

USER root
ENV DOCKER=YES

RUN npm i && npm i -g --production --unsafe

WORKDIR /usr/lib/node_modules/mirakurun/
CMD [ "npm", "start" ]

EXPOSE 40772
