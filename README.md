[![Mirakurun](https://yabumi.cc/159e63f5c692b3b0dae47765.svg)](https://github.com/Chinachu/Mirakurun)

# Mirakurun

DVR Tuner Server Service for **[Chinachu](https://chinachu.moe/)** Air.

[![npm version][npm-img]][npm-url]
[![npm downloads][downloads-image]][downloads-url]
[![Linux Build][azure-pipelines-img]][azure-pipelines-url]
[![Dependency Status][dep-img]][dep-url]
[![devDependency Status][devdep-img]][devdep-url]
[![tip for next commit](https://tip4commit.com/projects/43158.svg)](https://tip4commit.com/github/Chinachu/Mirakurun)
[![Backers on Open Collective](https://opencollective.com/Mirakurun/backers/badge.svg)](#backers)
[![Sponsors on Open Collective](https://opencollective.com/Mirakurun/sponsors/badge.svg)](#sponsors)

## Docker

[![dockeri.co](https://dockeri.co/image/chinachu/mirakurun)][docker-url]

see: available [Tags](https://hub.docker.com/r/chinachu/mirakurun/tags) (Docker Hub)

### Quick Install

```sh
mkdir ~/mirakurun/
cd ~/mirakurun/
wget https://raw.githubusercontent.com/Chinachu/Mirakurun/master/docker/docker-compose.yml
docker-compose pull
docker-compose run --rm -e SETUP=true mirakurun
docker-compose up -d
```

see: [doc/Platforms.md](doc/Platforms.md)

## Features

* RESTful API (Open API) - has designed like HTTP version of Spinel
* Unix Sockets / TCP
* Advanced Tuner Process Management
* Priority Management
* Tuner Device Pooling
* Integrated MPEG-2 TS Parser, Filter
* Realtime EPG Parser
* Supports most Tuner Devices (chardev, DVB / ISDB-T, ISDB-S, DVB-S2)
* Channel Scan
* IPv6 Support
* [Multiplexing Mirakuruns](doc/Mirakuruns.md)
* Web UI
* IPTV Server (M3U8 Playlist, XMLTV)

#### Figure: Variety of the MPEG-2 TS Stream API

![](https://yabumi.cc/1689b554eb4aea9bad992068.svg)

#### Figure: Stream Flow

![](https://yabumi.cc/1689b5d310c654a770d44e7a.svg)

## Requirements / Supported Platforms

* [Node.js](http://nodejs.org/) 10, 12, 14
* Linux w/ [PM2](http://pm2.keymetrics.io/) or [Docker](https://hub.docker.com/r/chinachu/mirakurun)

see: [doc/Platforms.md](doc/Platforms.md)

## **Install / Update / Uninstall / CLI**

see: [doc/Platforms.md](doc/Platforms.md)

## Web UI

```sh
# Admin UI
http://_your_mirakurun_ip_:40772/

# Swagger UI
http://_your_mirakurun_ip_:40772/api/debug
```

## PM2 Plus (Keymetrics)

You can use PM2 Plus to realtime monitoring if running by PM2.

* [PM2 Plus](https://pm2.io/plus/) (Keymetrics)

## Client Implementations

* [Rivarun](https://github.com/Chinachu/Rivarun)
* [BonDriver_Mirakurun](https://github.com/Chinachu/BonDriver_Mirakurun)
* Mirakurun Client ([Built-in](https://github.com/Chinachu/Mirakurun/blob/master/src/client.ts))
  * [Chinachu γ](https://github.com/Chinachu/Chinachu/wiki/Gamma-Installation-V2)
  * [EPGStation](https://github.com/l3tnun/EPGStation)

## Contributing

[CONTRIBUTING.md](.github/CONTRIBUTING.md)

## Supporting

* [Tip4Commit](https://tip4commit.com/github/Chinachu/Mirakurun) (BTC) - to Every Committers
* [Open Collective](https://opencollective.com/Mirakurun) (USD) - Pool (TBD)

## Discord Community

* Invitation: https://discord.gg/X7KU5W9

## Contributors

This project exists thanks to all the people who contribute.
<a href="https://github.com/Chinachu/Mirakurun/graphs/contributors"><img src="https://opencollective.com/Mirakurun/contributors.svg?width=890&button=false" /></a>

## Backers

Thank you to all our backers! 🙏 [[Become a backer](https://opencollective.com/Mirakurun#backer)]

<a href="https://opencollective.com/Mirakurun#backers" target="_blank"><img src="https://opencollective.com/Mirakurun/backers.svg?width=890"></a>

## Sponsors

Support this project by becoming a sponsor. Your logo will show up here with a link to your website. [[Become a sponsor](https://opencollective.com/Mirakurun#sponsor)]

<a href="https://opencollective.com/Mirakurun/sponsor/0/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/0/avatar.svg"></a>
<a href="https://opencollective.com/Mirakurun/sponsor/1/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/1/avatar.svg"></a>
<a href="https://opencollective.com/Mirakurun/sponsor/2/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/2/avatar.svg"></a>
<a href="https://opencollective.com/Mirakurun/sponsor/3/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/3/avatar.svg"></a>
<a href="https://opencollective.com/Mirakurun/sponsor/4/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/4/avatar.svg"></a>
<a href="https://opencollective.com/Mirakurun/sponsor/5/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/5/avatar.svg"></a>
<a href="https://opencollective.com/Mirakurun/sponsor/6/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/6/avatar.svg"></a>
<a href="https://opencollective.com/Mirakurun/sponsor/7/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/7/avatar.svg"></a>
<a href="https://opencollective.com/Mirakurun/sponsor/8/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/8/avatar.svg"></a>
<a href="https://opencollective.com/Mirakurun/sponsor/9/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/9/avatar.svg"></a>

## Copyright / License

&copy; 2016- [kanreisa](https://github.com/kanreisa).

* Code: [Apache License, Version 2.0](LICENSE)
* Docs: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
* Logo: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

**Commercial License / Support** is provided by [Pixely LLC](https://pixely.jp/).

[npm-img]: https://img.shields.io/npm/v/mirakurun.svg
[npm-url]: https://npmjs.org/package/mirakurun
[downloads-image]: https://img.shields.io/npm/dm/mirakurun.svg?style=flat
[downloads-url]: https://npmjs.org/package/mirakurun
[azure-pipelines-img]: https://dev.azure.com/chinachu/Mirakurun/_apis/build/status/Chinachu.Mirakurun?branchName=master
[azure-pipelines-url]: hhttps://dev.azure.com/chinachu/Mirakurun/_build/latest?definitionId=1&branchName=master
[dep-img]: https://david-dm.org/Chinachu/Mirakurun.svg
[dep-url]: https://david-dm.org/Chinachu/Mirakurun
[devdep-img]: https://david-dm.org/Chinachu/Mirakurun/dev-status.svg
[devdep-url]: https://david-dm.org/Chinachu/Mirakurun#info=devDependencies
[docker-url]: https://hub.docker.com/r/chinachu/mirakurun
