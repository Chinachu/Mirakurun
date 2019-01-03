#!/bin/bash

#   Copyright 2016 Yuki KAN
#
#   Licensed under the Apache License, Version 2.0 (the "License");
#   you may not use this file except in compliance with the License.
#   You may obtain a copy of the License at
#
#       http://www.apache.org/licenses/LICENSE-2.0
#
#   Unless required by applicable law or agreed to in writing, software
#   distributed under the License is distributed on an "AS IS" BASIS,
#   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#   See the License for the specific language governing permissions and
#   limitations under the License.

if [ `whoami` != "root" ]; then
  echo "Error: root please."
  exit 1
fi

shopt -s extglob

main () {
  local SELF_PATH DIR SYM
  # get the absolute path of the executable
  SELF_PATH="$0"
  if [ "${SELF_PATH:0:1}" != "." ] && [ "${SELF_PATH:0:1}" != "/" ]; then
    SELF_PATH=./"$SELF_PATH"
  fi
  SELF_PATH=$( cd -P -- "$(dirname -- "$SELF_PATH")" \
            && pwd -P \
            ) && SELF_PATH=$SELF_PATH/$(basename -- "$0")

  # resolve symlinks
  while [ -h "$SELF_PATH" ]; do
    DIR=$(dirname -- "$SELF_PATH")
    SYM=$(readlink -- "$SELF_PATH")
    SELF_PATH=$( cd -- "$DIR" \
              && cd -- $(dirname -- "$SYM") \
              && pwd \
              )/$(basename -- "$SYM")
  done

  # path
  export MIRAKURUN_DIR=$(dirname -- "$SELF_PATH")/../

  cd $MIRAKURUN_DIR

  local cmd="$1"
  shift
  case $cmd in
    init | config | log | status | start | stop | restart | version )
      cmd="mirakurun_$cmd"
      ;;
    * )
      cmd="mirakurun_help"
      ;;
  esac

  $cmd "$@" && exit 0 || fail "failed somehow"
}

mirakurun_init() {
  node bin/preuninstall.js
  node bin/postinstall.js
  return 0
}

mirakurun_config () {
  case $1 in
    server | tuners | channels )
      "${EDITOR:-vi}" /usr/local/etc/mirakurun/$1.yml
      ;;
    * )
      mirakurun_help
      ;;
  esac

  return 0
}

mirakurun_log () {
  pm2 logs mirakurun-server "$@" && return 0
}

mirakurun_status () {
  pm2 status && return 0
}

mirakurun_start () {
  pm2 start mirakurun-server && return 0
}

mirakurun_stop () {
  pm2 stop mirakurun-server && return 0
}

mirakurun_restart() {
  pm2 restart mirakurun-server && return 0
}

mirakurun_version () {
  npm list -g mirakurun && return 0
}

mirakurun_help () {
  cat <<EOF

Usage: mirakurun <command> ...

<command>:

init              Init as service manually.

config server     Edit server configuration.
config tuners     Edit tuner configuration.
config channels   Edit channels configuration.

log               Stream logs.
log --help        Show usage for log stream.

status            Show status of services.
start             Start services.
stop              Stop services.
restart           Restart services.

version           Version info.
help              Output this information.

EOF

  return 0
}

fail () {
  echo "$@" >&2
  exit 1
}

main "$@"
