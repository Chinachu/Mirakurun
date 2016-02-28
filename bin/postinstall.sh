#!/bin/sh

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

if [ `whoami` != 'root' ]; then
  exit 0
fi

# init

mkdir -vp /usr/local/etc/mirakurun
mkdir -vp /usr/local/var/log
mkdir -vp /usr/local/var/run
mkdir -vp /usr/local/var/db

cp -vn config/server.yml /usr/local/etc/mirakurun/server.yml
cp -vn config/tuners.yml /usr/local/etc/mirakurun/tuners.yml
cp -vn config/channels.yml /usr/local/etc/mirakurun/channels.yml

# pm2

pm2 start processes.json

pm2 startup
pm2 save