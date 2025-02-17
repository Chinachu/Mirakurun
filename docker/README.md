## Docker Development Commands:

```sh
# build
docker compose -f docker/docker-compose.yml build
# run
docker compose -f docker/docker-compose.yml run --rm --service-ports mirakurun
# run w/ env
docker compose -f docker/docker-compose.yml run --rm --service-ports -e LOG_LEVEL=3 mirakurun
# setup
docker compose -f docker/docker-compose.yml run --rm --service-ports -e SETUP=true mirakurun
```
