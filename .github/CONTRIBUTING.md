# Contributing

## Report an Issue

* https://github.com/Chinachu/Mirakurun/issues

When reporting an issue we also need as much information about your environment
that you can include. We never know what information will be pertinent when
trying narrow down the issue. **Please include least the following information**:

* Platform you're running on (Debian jessie, CentOS 7.1, ...)
* (if Mirakurun is working) http://_mirakurun-server-ip_:40772/api/status → https://gist.github.com/

## Development

### Checkout

```
git clone git@github.com:Chinachu/Mirakurun.git
cd Mirakurun
git checkout <branch>
```

### Build

```
npm install
npm run build
```

### Install

```
# Linux / Darwin
sudo npm install pm2 -g
sudo npm install . -g --unsafe-perm --production

# Win32 (Windows PowerShell as Admin)
npm install winser -g
npm install . -g --production
```

### Debug

```
# Linux / Darwin
sudo mirakurun stop
sudo npm run debug

# Win32 (Windows PowerShell as Admin)
Stop-Service mirakurun
npm run debug.win32
```

If you've any questions, please ask on Slack.
