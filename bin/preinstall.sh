#!/bin/sh

if [ ${EUID:-${UID}} != 0 ]; then
  echo "root please." 1>&2
  exit 1
fi

mkdir -pv /etc/mirakurun

exit 0
