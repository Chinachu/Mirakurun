#!/bin/bash

export SERVER_CONFIG_PATH=/app-config/server.yml
export TUNERS_CONFIG_PATH=/app-config/tuners.yml
export CHANNELS_CONFIG_PATH=/app-config/channels.yml
export SERVICES_DB_PATH=/app-data/services.json
export PROGRAMS_DB_PATH=/app-data/programs.json
export LOGO_DATA_DIR_PATH=/app-data/logo-data

export PATH=/opt/bin:$PATH
export DOCKER=YES
export INIT_PID=$$

# npm
export npm_config_cache=/tmp/.npm
export npm_config_update_notifier=false

# tweaks for glibc memory usage
export MALLOC_ARENA_MAX=2

# trap
function trap_exit() {
  echo "stopping... $(jobs -p)"
  kill $(jobs -p) > /dev/null 2>&1 || echo "already killed."
  if [ "$DISABLE_PCSCD" != "1" ] && [ -e "/etc/init.d/pcscd" ]; then
    /etc/init.d/pcscd stop
  fi
  sleep 1
  echo "exit."
}
trap "exit 0" 2 3 15
trap trap_exit 0

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

# custom startup script
if [ -e "/opt/bin/startup" ]; then
  echo "executing /opt/bin/startup..."
  /opt/bin/startup
  echo "done."
fi

# only for test purpose
if [ "$DISABLE_B25_TEST" != "1" ] && !(type "arib-b25-stream-test" > /dev/null 2>&1); then
  npm --prefix /opt install arib-b25-stream-test
  ln -sv /opt/node_modules/arib-b25-stream-test/bin/b25 /opt/bin/arib-b25-stream-test
fi

if [ "$DISABLE_PCSCD" != "1" ] && [ -e "/etc/init.d/pcscd" ]; then
  while :; do
    echo "starting pcscd..."
    /etc/init.d/pcscd start
    sleep 1
    timeout 2 pcsc_scan | grep -A 50 "Using reader plug'n play mechanism"
    if [ $? = 0 ]; then
      break;
    fi
    echo "failed!"
  done
fi

function start() {
  if [ "$DEBUG" != "true" ]; then
    export NODE_ENV=production
    node --max-semi-space-size=64 -r source-map-support/register lib/server.js &
  else
    npm run debug &
  fi

  wait
}

function restart() {
  echo "restarting... $(jobs -p)"
  kill $(jobs -p) > /dev/null 2>&1 || echo "already killed."
  sleep 1
  start
}
trap restart 1

start
