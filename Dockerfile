FROM node:14.0.0 AS build
WORKDIR /app
ENV DOCKER=YES
ADD . .
RUN npm install && \
    npm run build && \
    npm install -g --production --unsafe-perm

FROM node:14.0.0-slim
WORKDIR /usr/local/lib/node_modules/mirakurun/
ENV DOCKER=YES
COPY --from=build /usr/local/lib/node_modules/mirakurun /usr/local/lib/node_modules/mirakurun
CMD [ "npm", "start" ]
EXPOSE 40772 41772
