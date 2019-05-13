FROM node:10.15.3-alpine AS build
WORKDIR /app
ENV DOCKER=YES
ADD . .
RUN npm install && \
    npm run build && \
    npm install -g --production --unsafe-perm

FROM node:10.15.3-alpine
WORKDIR /usr/local/lib/node_modules/mirakurun/
ENV DOCKER=YES
COPY --from=build /usr/local/lib/node_modules/mirakurun /usr/local/lib/node_modules/mirakurun
CMD [ "npm", "start" ]
EXPOSE 40772 41772
