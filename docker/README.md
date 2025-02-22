## Docker Development Commands:

```sh
# build
npm run docker:build
# setup
npm run docker:run-setup
# run
npm run docker:run
# run w/ env
docker compose -f docker/docker-compose.yml run --rm --service-ports -e LOG_LEVEL=3 mirakurun
```
