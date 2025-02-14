# Contributing

## Report an Issue (問題の報告)

All issues that are not bugs or cannot be reproduced will be closed due to the limited moderating capacity at the moment.
If you have any comments or requests, please send them to the Discord.<br>
現在、管理体制が限定的なため、バグではないか、バグが再現できない Issue は全てクローズされます。
ご意見・ご要望については、是非 Discord にお寄せください。

* https://github.com/Chinachu/Mirakurun/issues

When reporting an issue we also need as much information about your environment
that you can include. We never know what is your environment.<br>
問題を報告するときは、できるだけ多くの環境情報を含めてください。
多種多様な環境が存在する中で、我々は個々の環境情報を特定できません。

* Platform you're running on (Debian jessie, CentOS 7.1, ...)
* (if Mirakurun is working) http://_mirakurun-server-ip_:40772/api/status → https://gist.github.com/

## Development

### Checkout

```
git clone git@github.com:Chinachu/Mirakurun.git
cd Mirakurun
git checkout <branch>
git submodule update --init
```

### Build

```sh
# Docker on Linux
npm run docker:build

# Linux
npm install
npm run build
```

### Run

```sh
# Docker on Linux
npm run docker:run

# Linux
sudo npm run start
```

### Debug

```sh
# Docker on Linux
npm run docker:debug

# Linux
sudo npm run debug
```

If you've any questions, please ask on Discord.
