# Contributing

## Report an Issue

* https://github.com/kanreisa/Mirakurun/issues

When reporting an issue we also need as much information about your environment
that you can include. We never know what information will be pertinent when
trying narrow down the issue. Please include least the following information:

* Version of Mirakurun: `sudo npm list -g mirakurun`
* Version of Chinachu: `sudo npm list -g chinachu`
* Platform you're running on (Debian jessie, CentOS 7.1, ...)
* Architecture you're running on (x86 or x64)

**Please note: ARM architectures currently not supported.**

## Development

To get started, [sign the Contributor License Agreement](https://www.clahub.com/agreements/kanreisa/Mirakurun).

### Pull Request

Please PR to the [develop](https://github.com/kanreisa/Mirakurun/tree/develop) branch.
Please don't PR to the master branch it's protected.

### Checkout

```
git clone git@github.com:kanreisa/Mirakurun.git
cd Mirakurun
git checkout develop
```

### Build

```
npm install
npm run tsd-install
npm run build
```

### Install

```
sudo npm install pm2 -g
sudo npm install . -g --unsafe --production
```

If you've any questions, please ask on Slack.