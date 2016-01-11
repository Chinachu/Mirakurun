# Mirakurun
An Open Source DVR Tuner Server Service for **[Chinachu](https://chinachu.moe/)** Air.

[![npm version][npm-img]][npm-url]
[![Linux Build][travis-img]][travis-url]
[![Dependency Status][dep-img]][dep-url]
[![devDependency Status][devdep-img]][devdep-url]

## Requirements

* Linux - x86 / x64
  - Debian / CentOS / Gentoo
  - sysvinit / OpenRC / systemd
* [Node.js](nodejs.org/) `>=4.1.1`

## Install

```
sudo npm install mirakurun -g --unsafe --production
```

### Uninstall

```
sudo npm uninstall mirakurun -g --unsafe
```

## CLI

### Administration

#### Config

```
mirakurun config [server|tuners|channels]
```
Typically, don't need edit this.

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

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md)

## Slack Community

* Join: https://slack.chinachu.moe/
* Login: https://chinachu.slack.com/

## License

[Apache License, Version 2.0](LICENSE)

**Commercial License/Support** is provided by [Pixely LLC](https://pixely.jp/).

[npm-img]: https://img.shields.io/npm/v/Mirakurun.svg
[npm-url]: https://npmjs.org/package/Mirakurun
[travis-img]: https://img.shields.io/travis/kanreisa/Mirakurun.svg
[travis-url]: https://travis-ci.org/kanreisa/Mirakurun
[dep-img]: https://david-dm.org/kanreisa/Mirakurun.svg
[dep-url]: https://david-dm.org/kanreisa/Mirakurun
[devdep-img]: https://david-dm.org/kanreisa/Mirakurun/dev-status.svg
[devdep-url]: https://david-dm.org/kanreisa/Mirakurun#info=devDependencies