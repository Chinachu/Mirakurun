# Remarks for Platform Support

## Overview

**Bold** is the recommended. also, **Node.js** `^14.17.0 || ^16` needed.

* [**Docker on Linux**](#docker-on-linux)
  * [Docker Engine](https://docs.docker.com/engine/install/) `>=18.06.0`
  * [Docker Compose](https://docs.docker.com/compose/install/) `>=1.22.0`
  * **x64**
  * **Ubuntu Server 20.04** / Debian 9 / CentOS 8.1
  * ⚠ Note: Desktop Environment / VM is not supported and unstable!
* [Linux](#linux)
  * [PM2](http://pm2.keymetrics.io/) `>=2.4.0`
  * x86 / **x64** / ARMv7 / **ARMv8**
  * **Debian** / **Ubuntu Server** / CentOS / Gentoo
  * SystemV / OpenRC / **SystemD**
  * ⚠ Note: Desktop Environment / VM is not supported and unstable!
* [Win32](#win32) (Experimental, Unstable, Not Recommended, Not Tested)
  * [winser](https://github.com/jfromaniello/winser) `>=1.0.3`
  * ⚠ Note: WSL / Linux VM is not supported!

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
docker-compose pull
docker-compose run --rm -e SETUP=true mirakurun
docker-compose up -d

# Uninstall
cd ~/mirakurun/
docker-compose down --rmi all

# Update
cd ~/mirakurun/
docker-compose down --rmi all
docker-compose pull
docker-compose up -d
```

### Start / Stop / Restart / Status

```sh
# start / stop / restart
cd ~/mirakurun/
docker-compose [start|stop|restart]

# status
cd ~/mirakurun/
docker-compose ps
```

### Logs

```sh
cd ~/mirakurun/
docker-compose logs [-f]
```

### Config

```
vim /opt/mirakurun/config/server.yml
vim /opt/mirakurun/config/tuners.yml
vim /opt/mirakurun/config/channels.yml
```

see: [Configuration.md](Configuration.md)

### 💡 How to Use: Non-DVB Devices

```sh
$ which recpt1
/usr/local/bin/recpt1
$ cp /usr/local/bin/recpt1 /opt/mirakurun/opt/bin/
$ vim /opt/mirakurun/config/tuners.yml
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

## Linux

**Note:**

* ⚠ Any desktop environment / VM is not supported. lacking reliability by critical performance issue.

### Node.js

* **via Package Manager** (recommended)
  * [Debian / Ubuntu](https://github.com/nodesource/distributions/blob/master/README.md#deb) (deb)
    * `curl -sL https://deb.nodesource.com/setup_16.x | sudo -E bash -`
    * `sudo apt-get install -y nodejs`
  * [CentOS](https://github.com/nodesource/distributions/blob/master/README.md#rpm) (rpm)
    * (root) `curl -sL https://rpm.nodesource.com/setup_16.x | bash -`
  * [Gentoo](https://nodejs.org/en/download/package-manager/#gentoo)
    * `emerge nodejs`
* [nave](https://github.com/isaacs/nave)
  * `sudo /path/to/nave.sh usemain 16`

### Install / Update

```sh
# for building C++ addons (Debian / Ubuntu)
sudo apt install build-essential

# PM2 (Process Manager)
sudo npm install pm2 -g

# Quick
sudo npm install mirakurun -g --unsafe-perm --production

# Advanced
sudo npm install mirakurun -g --production
sudo mirakurun init # to install as service
sudo mirakurun restart # when updated
```

### Uninstall

```sh
# Quick
sudo npm uninstall mirakurun -g --unsafe-perm

# Advanced
sudo pm2 stop mirakurun-server
sudo pm2 delete mirakurun-server
sudo pm2 save
sudo npm uninstall mirakurun -g
```

### Administration

#### Config

```
mirakurun config [server|tuners|channels]
```

see: [Configuration.md](Configuration.md)

#### Log Stream

```
mirakurun log server
```

#### Service Management

```
mirakurun [status|start|stop|restart]
```

#### Version Info

```
mirakurun version
```


### 💡 Locations

* Socket: `/var/run/mirakurun.sock`
* Config: `/usr/local/etc/mirakurun/`
  * `server.yml`
  * `tuners.yml`
  * `channels.yml`
* Data: `/usr/local/var/db/mirakurun/`
  * `services.json`
  * `programs.json`
* Log: `/usr/local/var/log/`
  * `mirakurun.stdout.log` - normal log
  * `mirakurun.stderr.log` - error log

## Win32

**Note:**

- ⚠ Experimental, Unstable, Not Recommended, Not Tested
- ⚠ WSL / Linux VM is not supported!

### Node.js

* [**Windows installer**](https://nodejs.org/en/download/)

### Installing winser

**use Windows PowerShell as Admin.**

```
npm install winser@1.0.3 -g
```

### Install / Update

**use Windows PowerShell as Admin.**

```
npm install mirakurun@latest -g --production
```

### Uninstall

**use Windows PowerShell as Admin.**

```
npm uninstall mirakurun -g
```

### Service Management

```sh
# start
Start-Service mirakurun
# stop
Stop-Service mirakurun
```

also you can manage in Service Manager / Task Manager.

### 💡 Locations

* Socket: `\\.\pipe\mirakurun`
* Config: `${USERPROFILE}/.Mirakurun/`
  * `server.yml`
  * `tuners.yml`
  * `channels.yml`
* Data: `${LOCALAPPDATA}/Mirakurun/`
  * `services.json`
  * `programs.json`
* Log: `${LOCALAPPDATA}/Mirakurun/`
  * `stdout` - normal log
  * `stderr` - error log
