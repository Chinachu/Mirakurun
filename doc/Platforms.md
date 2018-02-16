# Remarks for Platform Support

## Overview

**Bold** is the recommended. also, **Node.js** `^8.9.4 < 9` needed.

* [**Linux**](#linux)
  * [PM2](http://pm2.keymetrics.io/) `>=2.4.0`
  * x86 / **x64** / ARMv7 / **ARMv8**
  * **Debian** / Ubuntu / CentOS / Gentoo
  * SystemV / OpenRC / **SystemD**
* [Win32](#win32) (Experimental)
  * [winser](https://github.com/jfromaniello/winser) `>=1.0.2`
  * Windows 10 RS1
  * Windows 10 RS2/RS3 `npm i @kanreisa/winser -g`
* Darwin (Experimental)
  * [PM2](http://pm2.keymetrics.io/) `>=2.4.0`

## Linux

### Installing Node.js

* [**via Package Manager**](https://nodejs.org/en/download/package-manager/#debian-and-ubuntu-based-linux-distributions) (recommended)
* [nave](https://github.com/isaacs/nave)
  * `sudo /path/to/nave.sh usemain 8.9.4`

### Installing PM2

```
sudo npm install pm2 -g
```

### Installing / Updating Mirakurun

```
sudo npm install mirakurun@latest -g --unsafe --production
```

### Uninstalling Mirakurun

```
sudo npm uninstall mirakurun -g --unsafe
```

### Default Paths

* `/usr/local/etc/mirakurun/` - configurations
  * `server.yml`
  * `tuners.yml`
  * `channels.yml`
* `/usr/local/db/mirakurun/` - databases
  * `services.json`
  * `programs.json`
* `/usr/local/var/log/mirakurun.stdout.log` - normal log
* `/usr/local/var/log/mirakurun.stderr.log` - error log

## Win32

### Installing Node.js

* [**Windows installer**](https://nodejs.org/en/download/)

### Installing winser

**use Windows PowerShell as Admin.**

```
npm install @kanreisa/winser -g
```

### Installing / Updating Mirakurun

**use Windows PowerShell as Admin.**

```
npm install mirakurun@latest -g --production
```

### Uninstalling Mirakurun

**use Windows PowerShell as Admin.**

```
npm uninstall mirakurun -g
```

### Managing Service

```sh
# start
Start-Service mirakurun
# stop
Stop-Service mirakurun
```

also you can use Service Manager of Task Manager.

### Default Paths

* `${USERPROFILE}/.Mirakurun/` - configurations
  * `server.yml`
  * `tuners.yml`
  * `channels.yml`
* `${LOCALAPPDATA}/Mirakurun/` - databases
  * `services.json`
  * `programs.json`
* `${LOCALAPPDATA}/Mirakurun/stdout` - normal log
* `${LOCALAPPDATA}/Mirakurun/stderr` - error log
