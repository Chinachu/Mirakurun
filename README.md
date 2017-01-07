[![Mirakurun](https://yabumi.cc/153eab7d76cd45beb272b916.svg)](https://github.com/Chinachu/Mirakurun)

# Mirakurun

DVR Tuner Server Service for **[Chinachu](https://chinachu.moe/)** Air.

[![npm version][npm-img]][npm-url]
[![npm downloads][downloads-image]][downloads-url]
[![Linux Build][travis-img]][travis-url]
[![Dependency Status][dep-img]][dep-url]
[![devDependency Status][devdep-img]][devdep-url]

## Features

* RESTful API (Open API) - has designed like HTTP version of Spinel
* Unix Sockets / TCP
* Advanced Tuner Process Management
* Priority Management
* Integrated MPEG-2 TS Parser, Filter
* Realtime EPG Parser
* Supports most Tuner Devices (chardev, DVB / ISDB-T, ISDB-S, DVB-S2)
* IPv6 Support

## Requirements / Supported Platforms

* [Node.js](http://nodejs.org/) `>=6.5.0`
* Linux w/ [PM2](http://pm2.keymetrics.io/)
* Win32 w/ [winser](https://github.com/jfromaniello/winser)

see: [doc/Platforms.md](doc/Platforms.md)

## Install

```
# Linux / Darwin
sudo npm install pm2 -g
sudo npm install mirakurun -g --unsafe --production

# Win32 (Windows PowerShell as Admin)
npm install winser -g
npm install mirakurun -g --production
```

### Update

```
# Linux / Darwin
sudo npm install mirakurun@latest -g --unsafe --production

# Win32 (Windows PowerShell as Admin)
npm install mirakurun@latest -g --production
```

### Uninstall

```
# Linux / Darwin
sudo npm uninstall mirakurun -g --unsafe

# Win32 (Windows PowerShell as Admin)
npm uninstall mirakurun -g
```

## CLI

**Only Linux / Darwin Platform**

### Administration

#### Config

```
mirakurun config [server|tuners|channels]
```

* Also you can config on Chinachu Web App.
* see: [doc/Configuration.md](doc/Configuration.md)

#### Log Stream

```
mirakurun log server
```

#### Service Management

```
mirakurun [status|start|stop|restart]
```

## Munin Plugin

**Required**
* [Munin](http://munin-monitoring.org/) `>=1.4.0`

### Installation

```
ln -s /usr/local/lib/node_modules/mirakurun/bin/munin-plugins/mirakurun_status.js /usr/share/munin/plugins/mirakurun_status
ln -s /usr/share/munin/plugins/mirakurun_status /etc/munin/plugins/mirakurun_status
# check
munin-run mirakurun_status
# apply
service munin-node restart
```

#### Workaround: `/usr/bin/env: node: No such file or directory`

create `/etc/munin/plugin-conf.d/mirakurun.conf` like below:

```
[mirakurun_*]
command /usr/local/bin/node %c
```

## Client Implementations

* [Rivarun](https://github.com/Chinachu/Rivarun)
* [BonDriver_Mirakurun](https://github.com/h-mineta/BonDriver_Mirakurun)

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md)

## Slack Community

* Join: https://slack.chinachu.moe/
* Login: https://chinachu.slack.com/

## License

[Apache License, Version 2.0](LICENSE)

**Commercial License/Support** is provided by [Pixely LLC](https://pixely.jp/).

[npm-img]: https://img.shields.io/npm/v/mirakurun.svg
[npm-url]: https://npmjs.org/package/mirakurun
[downloads-image]: https://img.shields.io/npm/dm/mirakurun.svg?style=flat
[downloads-url]: https://npmjs.org/package/mirakurun
[travis-img]: https://img.shields.io/travis/Chinachu/Mirakurun.svg
[travis-url]: https://travis-ci.org/Chinachu/Mirakurun
[dep-img]: https://david-dm.org/Chinachu/Mirakurun.svg
[dep-url]: https://david-dm.org/Chinachu/Mirakurun
[devdep-img]: https://david-dm.org/Chinachu/Mirakurun/dev-status.svg
[devdep-url]: https://david-dm.org/Chinachu/Mirakurun#info=devDependencies