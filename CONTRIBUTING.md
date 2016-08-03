# Contributing

## Report an Issue

* https://github.com/kanreisa/Mirakurun/issues

When reporting an issue we also need as much information about your environment
that you can include. We never know what information will be pertinent when
trying narrow down the issue. Please include least the following information:

* Version of Mirakurun: `sudo npm list -g mirakurun`
* Version of Chinachu: `sudo npm list -g chinachu`
* Platform you're running on (Debian jessie, CentOS 7.1, ...)
* Architecture you're running on (x86 or x64 or ARMv8 or ...)

## Development

To get started, [sign the Contributor License Agreement](https://www.clahub.com/agreements/kanreisa/Mirakurun).

### Checkout

```
git clone git@github.com:kanreisa/Mirakurun.git
cd Mirakurun
git checkout <branch>
```

### Build

```
npm install
npm run typings-install
npm run build
```

### Install

```
# Linux / Darwin
sudo npm install pm2 -g
sudo npm install . -g --unsafe --production

# Win32 (Windows PowerShell as Admin)
npm install winser -g
npm install . -g --production
```

### Debug with [node-inspector](https://github.com/node-inspector/node-inspector)

```
node-inspector &

# Linux / Darwin
sudo mirakurun stop
sudo npm run debug

# Win32 (Windows PowerShell as Admin)
Stop-Service mirakurun
npm run debug.win32
```

If you've any questions, please ask on Slack.
