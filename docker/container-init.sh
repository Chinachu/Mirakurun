#!/bin/bash

export SERVER_CONFIG_PATH=/app-config/server.yml
export TUNERS_CONFIG_PATH=/app-config/tuners.yml
export CHANNELS_CONFIG_PATH=/app-config/channels.yml
export SERVICES_DB_PATH=/app-data/services.json
export PROGRAMS_DB_PATH=/app-data/programs.json

export PATH=/opt/bin:$PATH
export DOCKER=YES

if [ ! -e "/opt/bin" ]; then
  mkdir -pv /opt/bin
fi

# rename wrong filename (migration from <= 3.1.1 >= 3.0.0)
if [ -f "/app-data/services.yml" -a ! -f "$SERVICES_DB_PATH" ]; then
  cp -v "/app-data/services.yml" "$SERVICES_DB_PATH"
fi
if [ -f "/app-data/programs.yml" -a ! -f "$PROGRAMS_DB_PATH" ]; then
  cp -v "/app-data/programs.yml" "$PROGRAMS_DB_PATH"
fi

# only for test purpose
if !(type "arib-b25-stream-test" > /dev/null 2>&1); then
  npm --prefix /opt install arib-b25-stream-test
  ln -sv /opt/node_modules/arib-b25-stream-test/bin/b25 /opt/bin/arib-b25-stream-test
fi

if [ -e "/etc/init.d/pcscd" ]; then
  /etc/init.d/pcscd start
  # sleep 1
  # timeout 2 pcsc_scan
fi

if [ "$DEBUG" != "true" ]; then
  npm run start
else
  npm run debug
fi
