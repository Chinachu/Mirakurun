# Remarks for Platform Support

## Overview

**Bold** is the recommended. also, **Node.js** `^18 || ^20 || ^22` needed.

* [**Docker on Linux**](#docker-on-linux)
  * [Docker Engine](https://docs.docker.com/engine/install/) `>=18.06.0`
  * [Docker Compose](https://docs.docker.com/compose/install/) `>=1.22.0`
  * **x64** / arm32v7 / **arm64v8**
  * **Ubuntu Server 20.04** / Debian 9 / CentOS 8.1
  * ⚠ Note: Desktop Environment / VM is not supported and unstable!

## Docker on Linux

**Note:**

* ⚠ Any desktop environment / VM is not supported. lacking reliability by critical performance issue.
* ⚠ You must **uninstall** `pcscd` if installed.
* PT2/PT3/PX-* users: Use default DVB driver instead of chardev driver.
  * please uninstall chardev drivers then reboot before install.

### Docker

```sh
# for new machine
curl -sSL https://get.docker.com/ | CHANNEL=stable sh
```

### Install / Uninstall / Update

```sh
# Create: /opt/mirakurun/
sudo mv -vf /usr/local/mirakurun /opt/mirakurun
sudo mkdir -p /opt/mirakurun/run /opt/mirakurun/opt /opt/mirakurun/config /opt/mirakurun/data

# Install
mkdir ~/mirakurun/
cd ~/mirakurun/
wget https://raw.githubusercontent.com/Chinachu/Mirakurun/master/docker/docker-compose.yml
docker compose pull
docker compose run --rm -e SETUP=true mirakurun
docker compose up -d

# Uninstall
cd ~/mirakurun/
docker compose down --rmi all

# Update
cd ~/mirakurun/
docker compose down --rmi all
docker compose pull
docker compose up -d
```

### Start / Stop / Restart / Status

```sh
# start / stop / restart
cd ~/mirakurun/
docker compose [start|stop|restart]

# status
cd ~/mirakurun/
docker compose ps
```

### Logs

```sh
cd ~/mirakurun/
docker compose logs [-f]
```

### Config

```
vim /opt/mirakurun/config/server.yml
vim /opt/mirakurun/config/tuners.yml
vim /opt/mirakurun/config/channels.yml
```

see: [Configuration.md](Configuration.md)

### 💡 How to Use: Non-DVB Devices

#### option: **using custom startup script**

```sh
mkdir -p /opt/mirakurun/opt/bin
vim /opt/mirakurun/opt/bin/startup # example ↓
chmod +x /opt/mirakurun/opt/bin/startup
```
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
docker compose down
docker compose run --rm -e SETUP=true mirakurun
docker compose up -d
```

#### option: **using static build**

```sh
$ cp /usr/local/bin/something-static /opt/mirakurun/opt/bin/
```

### 💡 Locations (Container)

* Socket: `/var/run/mirakurun.sock`
* Config: `/app-config/`
  * `server.yml`
  * `tuners.yml`
  * `channels.yml`
* Data: `/app-data/`
  * `services.json`
  * `programs.json`
* Opt: `/opt/`
  * `bin/`
  * `bin/startup` - custom startup script (optional)

### 💡 Locations (Host)

* Socket: `/opt/mirakurun/run/mirakurun.sock`
* Config: `/opt/mirakurun/config/`
  * `server.yml`
  * `tuners.yml`
  * `channels.yml`
* Data: `/opt/mirakurun/data/`
  * `services.json`
  * `programs.json`
* Opt: `/opt/mirakurun/opt/`
  * `bin/`
  * `bin/startup` - custom startup script (optional)
