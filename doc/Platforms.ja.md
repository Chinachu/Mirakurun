[**English**](Platforms.md) | [**日本語**](Platforms.ja.md)

# プラットフォーム / 環境構築手順

## 概要

**太字**が推奨環境です。

- [**Docker on Linux**](#docker-on-linux)
  - [Docker Engine](https://docs.docker.com/engine/install/) `>=20.10.0`
  - **x64** / arm32v7 / **arm64v8**
  - **Ubuntu Server 24.10** / 他
  - ⚠️注意: デスクトップ環境 / VM (仮想マシン) はサポートせず、不安定です!

- [Linux + PM2 (レガシー)](#linux--pm2-レガシー)
  - [Node.js](https://nodejs.org/en/download) `^18 || ^20 || ^22`
  - [PM2](https://pm2.keymetrics.io/)

## Docker on Linux

### ⚠️注意

- ⚠️デスクトップ環境 / VM はサポートしていません。重大なパフォーマンス問題により信頼性が低下します。
- ⚠️ホストに `pcscd` がインストールされている場合、コンテナ内の `pcscd` と競合しますので、**無効化**してください。
  - ホストの `pcscd` を使う場合:
    - 環境変数 `DISABLE_PCSCD=1` を設定するとコンテナ内の `pcscd` が無効になります。
    - `/var/run/pcscd/pcscd.comm:/var/run/pcscd/pcscd.comm` をマウントしてください。

### 🍱準備: DVB を使用する場合

- 使用するチューナーが DVB ドライバーに対応していれば、最も手軽です。
- チューナー設定が空の状態でセットアップコマンドを走らせると、チューナーが自動的に検出・保存されます。
- 録画コマンドの用意が不要です。
- 下記のチューナーは大抵 Linux カーネルに含まれていますが、ラズパイ向け等の一部軽量ディストリビューションではビルドが必要です。それぞれ必要なモジュールを有効にしてビルドしてください。
  - PT1, PT2: `earth-pt1`
  - PT3: `earth-pt3`
  - PX-S1UD: `smsusb`
  - 他 (動作報告があれば追記します)

```sh
# DVB デバイスの認識を確認
ls -l /dev/dvb
```

### 🍱準備: chardev を使用する場合

- DVB を使用できない場合、従来方式の chardev を使用できます。

#### startup スクリプトで、コンテナ初回起動時にビルドする例
```sh
# startup スクリプトでビルドする例
mkdir -p /opt/mirakurun/opt/bin
vim /opt/mirakurun/opt/bin/startup # 例 ↓
chmod +x /opt/mirakurun/opt/bin/startup
```

#### `/opt/mirakurun/opt/bin/startup`:
```bash
#!/bin/bash

if !(type "recpt1" > /dev/null 2>&1); then
  apt-get update
  apt-get install -y --no-install-recommends git autoconf automake

  mkdir /buildwork
  cd /buildwork
  git clone https://github.com/stz2012/recpt1.git
  cd recpt1/recpt1
  ./autogen.sh
  ./configure --prefix /opt
  make
  make install
  rm -rf /buildwork
fi

recpt1 -v
```
```sh
# 下記コマンドで startup スクリプトの実行・確認ができます (サーバーは起動しません)
docker compose run --rm -e SETUP=true mirakurun
```
#### static build を使用する例

```sh
# 共有ライブラリに依存しない場合
cp /usr/local/bin/something-static /opt/mirakurun/opt/bin/
```

### ⚡Docker Engineのインストール

```sh
# 新しいマシンの場合
curl -sSL https://get.docker.com/ | CHANNEL=stable sh
```

### ⚡インストール / アンインストール / アップデート

```sh
# 作成: /opt/mirakurun/
sudo mv -vf /usr/local/mirakurun /opt/mirakurun
sudo mkdir -p /opt/mirakurun/run /opt/mirakurun/opt /opt/mirakurun/config /opt/mirakurun/data

# インストール
mkdir ~/mirakurun/
cd ~/mirakurun/
wget https://raw.githubusercontent.com/Chinachu/Mirakurun/refs/heads/release/4.0.0/docker/docker-compose.yml
docker compose pull
docker compose run --rm -e SETUP=true mirakurun
docker compose up -d

# アンインストール
cd ~/mirakurun/
docker compose down --rmi all

# アップデート
cd ~/mirakurun/
docker compose down --rmi all
docker compose pull
docker compose up -d
```

### ⚡起動 / 停止 / 再起動

```sh
cd ~/mirakurun/

# 起動
docker compose up -d

# 停止
docker compose down

# 再起動
docker compose up -d --force-recreate
```

### ⚡ログ

```sh
cd ~/mirakurun/
docker compose logs [-f]
```

### ⚡設定

- 主要な設定は Web UI から変更できます
- 全ての設定は [Configuration.md](Configuration.ja.md) を参照してください

```
vim /opt/mirakurun/config/server.yml
vim /opt/mirakurun/config/tuners.yml
vim /opt/mirakurun/config/channels.yml
```

### 💡主なファイルパス (コンテナ)

- ソケット: `/var/run/mirakurun.sock`
- 設定: `/app-config/`
  - `server.yml`
  - `tuners.yml`
  - `channels.yml`
- データ: `/app-data/`
  - `services.json`
  - `programs.json`
- Opt: `/opt/`
  - `bin/`
  - `bin/startup` - カスタム起動スクリプト (オプション)

### 💡主なファイルパス (ホスト) *変更可能

- ソケット: `/opt/mirakurun/run/mirakurun.sock`
- 設定: `/opt/mirakurun/config/`
  - `server.yml`
  - `tuners.yml`
  - `channels.yml`
- データ: `/opt/mirakurun/data/`
  - `services.json`
  - `programs.json`
- Opt: `/opt/mirakurun/opt/`
  - `bin/`
  - `bin/startup` - カスタム起動スクリプト (オプション)

## Linux + PM2 (レガシー)

この方法は推奨されませんが、一部の古いユースケースの為に残されています。
PM2 に特別対応するコードはすでに削除されており、エクスペリエンスは低下します。

```sh
# 新規
git clone git@github.com:Chinachu/Mirakurun.git
cd Mirakurun
git submodule update --init --recursive

npm install
npm run build

npm install pm2 -g
pm2 startup

# 起動
pm2 start processes.json
pm2 save

# 停止
pm2 stop processes.json
pm2 save

# アップデート
git pull
npm run clean
npm run build
pm2 restart processes.json

# アンインストール
pm2 delete processes.json
pm2 save
```

### 💡主なファイルパス

- ソケット: `/var/run/mirakurun.sock`
- 設定: `/usr/local/etc/mirakurun/`
  - `server.yml`
  - `tuners.yml`
  - `channels.yml`
- データ: `/usr/local/var/db/mirakurun/`
  - `services.json`
  - `programs.json`
- ログ: `/usr/local/var/log/`
  - `mirakurun.stdout.log` - 通常のログ
  - `mirakurun.stderr.log` - エラーログ
