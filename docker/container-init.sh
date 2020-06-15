#!/bin/bash

export LOG_LEVEL=${LOG_LEVEL:-"2"}

export SERVER_CONFIG_PATH=/app-config/server.yml
export TUNERS_CONFIG_PATH=/app-config/tuners.yml
export CHANNELS_CONFIG_PATH=/app-config/channels.yml
export SERVICES_DB_PATH=/app-data/services.yml
export PROGRAMS_DB_PATH=/app-data/programs.yml

export PATH=/opt/bin:$PATH
export DOCKER=YES

if [ ! -e "/opt/bin" ]; then
  mkdir -pv /opt/bin
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
