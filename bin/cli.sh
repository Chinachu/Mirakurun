#!/bin/bash

cat <<EOF

CLI / PM2 support has been removed on @4.0.0.

Solutions:
- use Docker (recommended)
  - https://github.com/Chinachu/Mirakurun/blob/release/4.0.0/doc/Platforms.md#docker-on-linux
- use PM2 manually (legacy)
  - https://github.com/Chinachu/Mirakurun/blob/release/4.0.0/doc/Platforms.md#linux-w-pm2-legacy
- downgrade to @3.9.0-rc.4
  - sudo npm install mirakurun@3.9.0-rc.4 -g --unsafe-perm --foreground-scripts --production

EOF
