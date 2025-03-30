[**English**](Configuration.md) | [**日本語**](Configuration.ja.md)

# 設定

- 🗒️[server.yml](#serveryml) - サーバー設定
- 🗒️[tuners.yml](#tunersyml) - チューナー設定
- 🗒️[channels.yml](#channelsyml) - チャンネル設定

## 🗒️server.yml

📛 Web UI 設定一部対応

### ファイルパス

- 環境変数: `SERVER_CONFIG_PATH`
- Docker ホスト (デフォルト): `/opt/mirakurun/config/server.yml`
- Linux (レガシー): `/usr/local/etc/mirakurun/server.yml`

### サーバー設定一覧

| プロパティ (🗒️server.yml) | 環境変数 (🐋Docker) | タイプ | デフォルト | 説明 |
|------------|------------------|-------|-----------|------|
| `logLevel` | `LOG_LEVEL` | Integer | `2` | ログレベル (`-1`: FATAL から `3`: DEBUG) |
| `maxLogHistory` | `MAX_LOG_HISTORY` | Integer | `1000` | ログの最大保持行数 |
| `path` | - | String, null | 🗒️`/var/run/mirakurun.sock` | Unix Socket Path **※Docker では無視 (対応予定)** |
| `port` | - | Integer, null | `40772` | サーバーポート **※Docker ではコンテナ側 `40772` 固定** |
| `hostname` | `HOSTNAME` | String | `localhost` | ホスト名 |
| `disableIPv6` | - | Boolean | `false` | IPv6の無効化 **※Docker では常に無効** |
| `maxBufferBytesBeforeReady` | `MAX_BUFFER_BYTES_BEFORE_READY` | Integer | `8388608` | 準備完了前の最大バッファサイズ (バイト)<br>**※番組開始の頭が欠ける場合は増やす** |
| `eventEndTimeout` | `EVENT_END_TIMEOUT` | Integer | `1000` | イベント終了タイムアウト (ミリ秒)<br>**※番組終了が誤判定される場合は長くする** |
| `programGCJobSchedule` | `PROGRAM_GC_JOB_SCHEDULE` | String | `45 * * * *` | 番組一覧の GC スケジュール (cron 風形式) |
| `epgGatheringJobSchedule` | `EPG_GATHERING_JOB_SCHEDULE` | String | `20,50 * * * *` | EPG 収集スケジュール (cron 風形式) |
| `epgRetrievalTime` | `EPG_RETRIEVAL_TIME` | Integer | `600000` | EPG 取得時間 (ミリ秒) |
| `logoDataInterval` | `LOGO_DATA_INTERVAL` | Integer | `604800000` | ロゴデータ更新間隔 (ミリ秒) |
| `disableEITParsing` | `DISABLE_EIT_PARSING` | Boolean | `false` | ⚠️EIT パースの無効化 |
| `disableWebUI` | `DISABLE_WEB_UI` | Boolean | `false` | ⚠️Web UI の無効化 |
| `allowIPv4CidrRanges` | `ALLOW_IPV4_CIDR_RANGES` | String[] | `["10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]` | ⚠️許可する IPv4 CIDR ブロック |
| `allowIPv6CidrRanges` | `ALLOW_IPV6_CIDR_RANGES` | String[] | `["fc00::/7"]` | ⚠️許可する IPv6 CIDR ブロック |
| `allowOrigins` | `ALLOW_ORIGINS` | String[] | `["https://mirakurun-secure-contexts-api.pages.dev"]` | ⚠️🧪許可するオリジン (実験中) |
| `allowPNA` | `ALLOW_PNA` | Boolean | `true` | 🧪[PNA](https://github.com/WICG/private-network-access)/[LNA](https://github.com/explainers-by-googlers/local-network-access) 許可設定 (実験中) |
| `tsplayEndpoint` | `TSPLAY_ENDPOINT` | String | `https://mirakurun-secure-contexts-api.pages.dev/tsplay/` | 🧪TSPlay エンドポイント (実験中) |

## 🗒️tuners.yml

💯 Web UI 設定完全対応

### ファイルパス

- 環境変数: `TUNERS_CONFIG_PATH`
- Docker ホスト (デフォルト): `/opt/mirakurun/config/tuners.yml`
- Linux (レガシー): `/usr/local/etc/mirakurun/tuners.yml`

### 構造

```yaml
# 配列
- name: チューナー識別名 # String
  types: # (GR|BS|CS|SKY)[]
    - GR
    - BS
    - CS
    - SKY
  # chardev/dvb用
  # "<template>"は`commandVars[template]`または"(空)"に置き換えられます *@4.0.0~
  command: cmd <channel> --arg1 --arg2 <exampleArg1> <exampleArg2>... # String
  # dvb用
  dvbDevicePath: /dev/dvb/adapter/dvr/path # String
  # リモートMirakurunとの多重化用
  remoteMirakurunHost: 192.168.x.x # String
  remoteMirakurunPort: 40772 # Integer
  remoteMirakurunDecoder: false # Boolean
  # 以下はオプション
  decoder: cmd # String
  isDisabled: false # Boolean
```

#### decoder

必要に応じてCAS処理コマンドを指定します。

```
# 参考: MPEG-2 TS の流れ
+-------------+    +----------+    +---------+    +--------+
| TunerDevice | -> | TSFilter | -> | decoder | -> | (user) |
+-------------+    +----------+    +---------+    +--------+
               RAW           STRIPPED      DESCRAMBLED
```

```sh
# これは実装例です。テスト用のみ。
sudo npm install arib-b25-stream-test -g --unsafe-perm
```

## 🗒️channels.yml

💯 Web UI 設定完全対応

### ファイルパス

- 環境変数: `CHANNELS_CONFIG_PATH`
- Docker ホスト (デフォルト): `/opt/mirakurun/config/channels.yml`
- Linux (レガシー): `/usr/local/etc/mirakurun/channels.yml`

### 構造

```yaml
# 配列
- name: チャンネル識別名 # String
  type: GR # 列挙型 [GR|BS|CS|SKY]
  channel: '0' # String
  # 以下はオプション
  serviceId: 1234 # Integer - 指定しない場合、サービスは自動的にスキャンされます。
  tsmfRelTs: 1 # 数値: 1~15
  commandVars: # オプションのコマンド変数 *@4.0.0~
    satellite: EXAMPLE-SAT4A
    space: 0
    freq: 12345
    polarity: H
    exampleArg1: -arg0 -arg1=example
    exampleArg2: -arg2 "引用符を使用して空白を含むことができます"
  isDisabled: false # Boolean
```
