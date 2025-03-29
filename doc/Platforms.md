[**English**](Platforms.md) | [**日本語**](Platforms.ja.md)

# Notes and Instructions on Platform Support

## Overview

**Bold** indicates recommended environments.

- [**Docker on Linux**](#docker-on-linux)
  - [Docker Engine](https://docs.docker.com/engine/install/) `>=20.10.0`
  - **x64** / arm32v7 / **arm64v8**
  - **Ubuntu Server 24.10** / others
  - ⚠️Note: Desktop environments / VM are not supported and are unstable!

- [Linux + PM2 (Legacy)](#linux-with-pm2-legacy)
  - [Node.js](https://nodejs.org/en/download) `^18 || ^20 || ^22`
  - [PM2](https://pm2.keymetrics.io/)

## Docker on Linux

### ⚠️Caution

- ⚠️Desktop environments / VMs are not supported. Reliability is reduced due to significant performance issues.
- ⚠️If `pcscd` is installed on the host, please **disable** it.
  - If you want to use the host's `pcscd`:
    - Set the environment variable `DISABLE_PCSCD=1` to disable `pcscd` in the container.
    - Mount `/var/run/pcscd/pcscd.comm:/var/run/pcscd/pcscd.comm`.

### 🍱Preparation: When using DVB

- If your tuner supports DVB drivers, this is the easiest method.
- If tuner configuration is empty when running the setup command, tuners will be automatically detected and saved.
- No recording commands need to be prepared.
- The following tuners are usually included in the Linux kernel, but some lightweight distributions like Raspberry Pi OS may require building modules. Please enable and build the necessary modules:
  - PT1, PT2: `earth-pt1`
  - PT3: `earth-pt3`
  - PX-S1UD: `smsusb`
  - Others (will be updated as reports come in)

```sh
# Check DVB device recognition
ls -l /dev/dvb
```

### 🍱Preparation: When using chardev

- If DVB cannot be used, you can use the traditional chardev method.

#### Example of building on the first container startup using a startup script
```sh
# Example of building with a startup script
mkdir -p /opt/mirakurun/opt/bin
vim /opt/mirakurun/opt/bin/startup # Example ↓
chmod +x /opt/mirakurun/opt/bin/startup
```

#### `/opt/mirakurun/opt/bin/startup`:
```bash
#!/bin/bash

if !(type "recpt1" > /dev/null 2>&1); then
  apt-get update
  apt-get install -y --no-install-recommends git autoconf automake

  cd /tmp
  git clone https://github.com/stz2012/recpt1.git
  cd recpt1/recpt1
  ./autogen.sh
  ./configure --prefix /opt
  make
  make install
fi

recpt1 -v
```
```sh
# You can run and check the startup script with the following command (server will not start)
docker compose run --rm -e SETUP=true mirakurun
```
#### Example of using a static build

```sh
# When not dependent on shared libraries
cp /usr/local/bin/something-static /opt/mirakurun/opt/bin/
```

### ⚡Installing Docker Engine

```sh
# For a new machine
curl -sSL https://get.docker.com/ | CHANNEL=stable sh
```

### ⚡Installation / Uninstallation / Update

```sh
# Create: /opt/mirakurun/
sudo mv -vf /usr/local/mirakurun /opt/mirakurun
sudo mkdir -p /opt/mirakurun/run /opt/mirakurun/opt /opt/mirakurun/config /opt/mirakurun/data

# Installation
mkdir ~/mirakurun/
cd ~/mirakurun/
wget https://raw.githubusercontent.com/Chinachu/Mirakurun/refs/heads/release/4.0.0/docker/docker-compose.yml
docker compose pull
docker compose run --rm -e SETUP=true mirakurun
docker compose up -d

# Uninstallation
cd ~/mirakurun/
docker compose down --rmi all

# Update
cd ~/mirakurun/
docker compose down --rmi all
docker compose pull
docker compose up -d
```

### ⚡Start / Stop / Restart

```sh
cd ~/mirakurun/

# Start
docker compose up -d

# Stop
docker compose down

# Restart
docker compose up -d --force-recreate
```

### ⚡Logs

```sh
cd ~/mirakurun/
docker compose logs [-f]
```

### ⚡Configuration

- Major settings can be changed from the Web UI
- For all settings, refer to [Configuration.md](Configuration.md)

```
vim /opt/mirakurun/config/server.yml
vim /opt/mirakurun/config/tuners.yml
vim /opt/mirakurun/config/channels.yml
```

### 💡Main File Locations (Container)

- Socket: `/var/run/mirakurun.sock`
- Configuration: `/app-config/`
  - `server.yml`
  - `tuners.yml`
  - `channels.yml`
- Data: `/app-data/`
  - `services.json`
  - `programs.json`
- Opt: `/opt/`
  - `bin/`
  - `bin/startup` - Custom startup script (optional)

### 💡Main File Locations (Host) *Customizable

- Socket: `/opt/mirakurun/run/mirakurun.sock`
- Configuration: `/opt/mirakurun/config/`
  - `server.yml`
  - `tuners.yml`
  - `channels.yml`
- Data: `/opt/mirakurun/data/`
  - `services.json`
  - `programs.json`
- Opt: `/opt/mirakurun/opt/`
  - `bin/`
  - `bin/startup` - Custom startup script (optional)

## Linux with PM2 (Legacy)

This method is not recommended but is kept for some older use cases.
Special code supporting PM2 has already been removed, and the experience is degraded.

```sh
# New installation
git clone git@github.com:Chinachu/Mirakurun.git
cd Mirakurun
git submodule update --init --recursive

npm install
npm run build

npm install pm2 -g
pm2 startup

# Start
pm2 start processes.json
pm2 save

# Stop
pm2 stop processes.json
pm2 save

# Update
git pull
npm run clean
npm run build
pm2 restart processes.json

# Uninstall
pm2 delete processes.json
pm2 save
```

### 💡Main File Locations

- Socket: `/var/run/mirakurun.sock`
- Configuration: `/usr/local/etc/mirakurun/`
  - `server.yml`
  - `tuners.yml`
  - `channels.yml`
- Data: `/usr/local/var/db/mirakurun/`
  - `services.json`
  - `programs.json`
- Logs: `/usr/local/var/log/`
  - `mirakurun.stdout.log` - Normal logs
  - `mirakurun.stderr.log` - Error logs
