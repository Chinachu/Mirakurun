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
  echo "Note: \`sudo npm install mirakurun -g --unsafe --production\` to install Mirakurun as Server."
  exit 0
fi

npm install pm2@1.0.0 -g
pm2 update

pm2 stop processes.json -s
pm2 delete processes.json -s