[**English**](Configuration.md) | [**日本語**](Configuration.ja.md)

# 設定

- 🗒️[server.yml](#serveryml) - サーバー設定
- 🗒️[tuners.yml](#tunersyml) - チューナー設定
- 🗒️[channels.yml](#channelsyml) - チャンネル設定

## ⚠️セキュリティ上の留意事項 (FYI)

- Mirakurun は LAN 内専用サーバーです。
- デフォルト設定でアクセス元をプライベート IP のみに制限しています。
- 任意のホスト名・ドメイン上のページからのアクセスを禁止しています。 → **DNS Rebinding / CSRF 攻撃対策**
  - `hostname`: Web UI にアクセスするためのホスト名を設定してください。
  - `allowOrigins`: 必要に応じて、許可するホスト名・ドメインを明示的に設定してください。
- 複数の手法を組み合わせて攻撃のリスクを緩和しています。
- 無暗に全てのドメインから API アクセスできるようにしたり、リバースプロキシの下に置かないでください。下記のような攻撃に対して脆弱になります。
  - 認証済みの BASIC 認証やセッション情報などを流用して攻撃する手法が存在します。
  - 最近はブラウザ自体もある程度保護していますが、過信しないでください。
  - リバースプロキシで HTTPS 化した場合、ブラウザ自体と Mirakurun の保護機能をいくつかバイパスする可能性があり、逆に危険度が増します。 → [保護されたコンテキスト](https://developer.mozilla.org/ja/docs/Web/Security/Secure_Contexts)
  - 代わりに VPN や SSH トンネル、トンネルサービスを活用してください。
    - 一部のトンネルサービスは `allowIPv4CidrRanges` の設定が必要です。第三者がアクセスできないように注意して設定してください。

> **DNS Rebinding 攻撃**: 攻撃者が管理するドメインで最初に正規サイトを返し、TTL期限後に攻撃者のサーバーを指すように変更する攻撃。これによりブラウザの同一オリジンポリシーを迂回し、ブラウザ経由で LAN 内のサーバーに不正アクセスする攻撃。

> **XSS/CSRF 攻撃**: 攻撃者が悪意のあるコードをウェブサイトに埋め込み、ブラウザ経由で LAN 内のサーバーに不正アクセスする攻撃。

- 攻撃例:
  - チューナーコマンド等を利用して任意のコードを実行
  - サーバーに不正なコードを仕込み、botnet 化
- 上記はあくまで攻撃の一例です。ブラウザやミドルウェアの脆弱性等により、日々様々な攻撃手法が考えられています。
- 近年増加傾向の Web ベースのアプリでは、ブラウザと同様の攻撃が可能な場合があります。注意しましょう。

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
| `path` | - | String, null | 🗒️`/var/run/mirakurun.sock` | Unix Socket Path **※Docker ではデフォルトパスに固定** |
| `port` | - | Integer, null | `40772` | サーバーポート **※Docker ではコンテナ側 `40772` 固定** |
| `hostname` | `HOSTNAME` | String | `localhost` | ホスト名 |
| `disableIPv6` | - | Boolean | `false` | IPv6の無効化 **※Docker では常に無効** |
| `jobMaxRunning` | `JOB_MAX_RUNNING` | Integer | 論理コア数 / 2, 最低 1, 最大 100 | 同時実行できる最大ジョブ数 |
| `jobMaxStandby` | `JOB_MAX_STANDBY` | Integer | 論理コア数 - 1, 最低 1, 最大 100 | 同時実行できる最大ジョブ準備数 |
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
| `defaultTlvStreamFormat` | `DEFAULT_TLV_STREAM_FORMAT` | String | `tlv` | `format` を付けないストリームの要求に対する、TLV (MMT) のチャンネルの出力形式 (`ts` または `tlv`)<br>`ts` を指定した場合、対象チャンネルを受信できるチューナーに `tlvToTsDecoder` が設定されていなければ HTTP 406 を返す |

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
  types: # (GR|BS|CS|SKY|BS4K)[]
    - GR
    - BS
    - CS
    - SKY
  routes: # (TER|SAT|CATV|HIKARI)[] - 受信できる経路。省略した場合はすべての経路
    - TER
    - CATV
  # chardev/dvb用
  # "<template>"は`commandVars[template]`または"(空)"に置き換えられます *@4.0.0~
  # "<route>"は選局するチャンネルの経路の小文字 (ter|sat|catv|hikari) に置き換えられます
  command: cmd <channel> --arg1 --arg2 <exampleArg1> <exampleArg2>... # String
  # dvb用
  dvbDevicePath: /dev/dvb/adapter/dvr/path # String
  disableDvbDirect: false # Boolean
  # リモートMirakurunとの多重化用
  remoteMirakurunHost: 192.168.x.x # String
  remoteMirakurunPort: 40772 # Integer
  remoteMirakurunDecoder: false # Boolean
  # 以下はオプション
  decoder: cmd # String
  tlvDecoder: cmd # String
  tlvToTsDecoder: cmd # String
  isDisabled: false # Boolean
```

公開型 `ChannelType` に `BS4K` を追加しています。TypeScript で従来の4種を網羅する `switch` や `Record<ChannelType, ...>` を使っている場合は、`BS4K` の分岐やキーを追加してください。従来の `GR`・`BS`・`CS`・`SKY` も引き続き使用できます。

#### routes

チューナーが受信できる経路です。チャンネルの `route` が `routes` に含まれるチューナーだけで選局します。省略した場合は、すべての経路を受信できるものとして扱います (従来と同じ)。

たとえば、BS を CATV のトランスモジュレーションで受信するチューナーには、`types` に `BS` を、`routes` に `CATV` を指定します。衛星のアンテナに接続したチューナーには `routes` に `SAT` を指定すると、CATV のチャンネルの選局には使われません。

#### DVB デバイスの直接操作

`command` に `dvbv5-zap` を指定したチューナーは、Mirakurun がコマンドを実行せずに DVB デバイスを直接操作して選局します。プロセスの起動と終了を待たないぶん、選局が速くなります。従来どおりコマンドを実行する場合は、`disableDvbDirect: true` を設定してください。

対象になるかどうかは、`command` の先頭にあるコマンド名 (ディレクトリを除いた部分) で判断します。そのため、`/opt/bin/dvbv5-zap` のように `dvbv5-zap` という名前で置いた自作のラッパースクリプトも実行されません。

##### 対応するオプション

`dvbv5-zap` のオプションのうち、次のものを読み取って使います。長い形式 (`--adapter` など) でも指定できます。

- `-a`, `-f`, `-d`: アダプター、frontend、demux の番号 (dvr は demux と同じ番号)
- `-c`: チャンネル設定ファイル (必須)
- `-P`: すべての PID を出力 (必須)
- `-I DVBV5`: チャンネル設定ファイルの形式
- `-l`, `-S`, `-W`, `-U`: 衛星の LNBf、DiSEqC、SCR/Unicable
- `-w`: LNA

出力先の指定 (`-r`, `-o -`) と表示の指定 (`-s`, `-v`, `-N`) は無視します。

衛星では、LNB 給電、22kHz トーン、DiSEqC、周波数の変換を `dvbv5-zap` と同じように行い、チャンネル設定ファイルの `LNB`, `POLARIZATION`, `SAT_NUMBER` も同じように使います。LNBf を `-l` とチャンネル設定ファイルの `LNB` のどちらでも指定していない場合は、周波数を変換せず、LNB にも給電しません。

対応している伝送方式は ISDB-T と ISDB-S です。

`-c` には `<route>` を使えます (`-c ./conf/dvbv5_channels_<route>.conf` など)。この場合は、`routes` (省略した場合はすべての経路) のそれぞれのチャンネル設定ファイルを読み、選局するチャンネルの経路のファイルを使います。

##### コマンドを実行する場合

次のいずれかに当てはまる場合は、直接操作せずに従来どおりコマンドを実行します。起動時にはその理由をログに警告として出力します。

- 上の一覧にないオプションや値 (`-t`、`-I ZAP` など) を指定している
- `-c` または `-P` を指定していない
- オプション以外の引数が `<channel>` だけではない
- オプションの数値の先頭に 0 が付いている (`dvbv5-zap` は 8 進数として扱うため)
- `dvbDevicePath` が、`-a` と `-d` から決まる `/dev/dvb/adapter<a>/dvr<d>` と異なる
- チャンネル設定ファイルに、対応していない項目や重複した項目、`FREQUENCY` のないチャンネルがある
- チャンネル設定ファイルに、`dvbv5-zap` とは解釈が変わる書き方がある (`=` の前に空白がない、値の末尾に空白がある、改行が CRLF である)

起動後にチャンネル設定ファイルを編集して読み込めなくなった場合は、ファイルを直すまで、選局のたびにコマンドを実行します。

##### 従来との違い

直接操作している間は、次の点が従来と異なります。

- API で返すチューナーの `command` は `/dev/dvb/adapter<n> <channel>`、`pid` は `null` になります。
- 次の選局を速くするため、チューナーを解放した後も 1 秒間は frontend を開いたままにします。
- 選局に失敗した場合 (デバイスを開けない、チャンネルが見つからないなど) は、選局をやり直さずにストリームの要求をエラーにします。
- デバイスが見つからないことによる失敗が 3 回続くと、そのチューナーを故障として扱い、Mirakurun を再起動するまで使いません。USB チューナーを挿し直した場合も再起動が必要です。

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

#### tlvDecoder / tlvToTsDecoder

TLV (MMT) のチャンネルでは、タイプにかかわらず、`decoder` の代わりにこれらを使います。どちらも引数を付けて指定できます (空白を含む場合は引用符で囲みます)。

- `tlvDecoder`: TLV を入力して TLV を出力する CAS 処理コマンド
- `tlvToTsDecoder`: TLV を入力して MPEG-2 TS を出力するコマンド

```
# 参考: TLV の流れ
+-------------+    +-----------+    +------------+    +----------------+    +--------+
| TunerDevice | -> | TLVFilter | -> | tlvDecoder | -> | tlvToTsDecoder | -> | (user) |
+-------------+    +-----------+    +------------+    +----------------+    +--------+
               TLV             TLV               TLV                   TS
```

ストリームの API に `format=tlv` を付けると `tlvToTsDecoder` を通さずに TLV を出力し、`format=ts` を付けると `tlvToTsDecoder` を設定したチューナーだけを使って TS を出力します。`format` を付けない場合は、`defaultTlvStreamFormat` に従います。出力できない形式を要求した場合は 406 を返します。

`tlvToTsDecoder` が起動に失敗し続けた場合は、TLV を出力せずにストリームを終了します。`tlvDecoder` は、`decoder` と同じく入力をそのまま出力します。

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
  type: GR # 列挙型 [GR|BS|CS|SKY|BS4K]
  channel: '0' # String
  # 以下はオプション
  route: TER # 列挙型 [TER|SAT|CATV|HIKARI] - 受信する経路。省略した場合、GR は TER、それ以外は SAT
  serviceId: 1234 # Integer - 指定しない場合、サービスは自動的にスキャンされます。
  tsmfRelTs: 1 # 数値: 1~15 - TSMF の相対 TS 番号 (TS と TLV のどちらも)。指定しない場合、TLV 用のチューナー (タイプに BS4K を含むか、tlvDecoder / tlvToTsDecoder を設定したもの) ではサービスのスキャンで判別する。TS だけのチューナーでは指定が必要
  tsmfGroupId: 1 # 数値: 1~255 - 1 つの TLV を複数の搬送波で伝送する場合 (CATV のチャネルボンディング) のグループ。同じ値のチャンネルが同じグループの搬送波になる。tsmfRelTs とともに指定しない場合、TLV 用のチューナーではサービスのスキャンで判別する
  format: tlv # 列挙型 [ts|tlv] - 指定しない場合、サービスのスキャンで判別した形式 (スキャンの前は BS4K なら tlv、それ以外は ts)
  commandVars: # オプションのコマンド変数 *@4.0.0~
    satellite: EXAMPLE-SAT4A
    space: 0
    freq: 12345
    polarity: H
    exampleArg1: -arg0 -arg1=example
    exampleArg2: -arg2 "引用符を使用して空白を含むことができます"
  isDisabled: false # Boolean
```

#### tsmfRelTs

TSMF で多重化されたチャンネルの相対 TS 番号です。拡張 TSMF で TLV を伝送する相対 TS も指定できます。

指定しない場合は、サービスのスキャンのときに TSMF の多重フレームヘッダーから、使われているすべての相対 TS と、それぞれが TS か TLV かを判別し、相対 TS ごとにサービスをスキャンします (`channels.json` に保存します)。サービスを新しく登録するのは、これまでどおり、チャンネルにサービスがないときのスキャンだけです。サービスや番組のストリームは、サービスの相対 TS を受信します。判別するのは、`format` と同じく、タイプに `BS4K` を含むか、`tlvDecoder` / `tlvToTsDecoder` を設定したチューナーでスキャンした場合だけです。TS だけのチューナーで TSMF のチャンネルを受信する場合は、`tsmfRelTs` を指定してください。

チャンネル単位のストリーム (`/api/channels/{type}/{channel}/stream`) では、`tsmfRelTs` のクエリで相対 TS を指定できます。指定しない場合は、これまでどおり channels.yml の `tsmfRelTs` の相対 TS (指定がなければ受信したままのストリーム) を出力します (リモートの Mirakurun が受信するため)。TSMF を判別したチャンネルの受信したままのストリームは、タイプが `BS4K` でも TS です (`format` を指定した場合を除く)。サービスのストリームの相対 TS がわからない場合は、サービスのネットワークの相対 TS (なければすべての相対 TS) のうち、スロットの数がいちばん多い相対 TS (同じ数なら番号の小さいほう) を受信します。判別した相対 TS は、リモートのチューナーでは受信しません (リモートの Mirakurun は、その Mirakurun の相対 TS を出力するため)。リモートのチューナーしかない場合は、これまでどおり受信したままのストリームを受信します (`tsmfRelTs` のクエリで判別した相対 TS を指定した場合は 503 を返します)。

#### format

チャンネルで受信するデータの形式です。TLV (MMT) の場合は `tlv` です。

指定しない場合は、サービスのスキャンのときに受信したデータから判別し、`channels.json` に保存します。判別するのは、タイプに `BS4K` を含むか、`tlvDecoder` / `tlvToTsDecoder` を設定したチューナーでスキャンした場合だけです (TS だけの環境の処理を増やさないため)。視聴や録画などのストリームでは判別せず、保存した形式を使います (TS のストリームの開始を遅らせないため)。スキャンの前は、種別が `BS4K` なら `tlv`、それ以外は `ts` として扱います。

`format` は、チャンネルのストリーム (`tsmfRelTs` の相対 TS、指定がなければ受信したままのストリーム) の形式です。`tsmfRelTs` を指定せずに TSMF の相対 TS を判別した場合、それぞれの相対 TS は判別した形式で受信します。

#### tsmfGroupId

CATV で 1 つの TLV を複数の搬送波に分けて伝送する場合 (チャネルボンディング) に指定します。同じ `type` と `tsmfGroupId` のチャンネルを同じグループの搬送波として、それぞれ別のチューナーで同時に選局し、TLV を組み立てます。グループのどのチャンネルを要求しても同じ TLV を出力します。

- 搬送波の数だけ、選局できるチューナーが必要です。搬送波のチューナーは、`/api/tuners` に `<利用者の ID>#carrier<n>` の利用者として表示されます。
- 同じ搬送波を受信しているチューナーは、EPG 取得や他の配信と共有します。同じ受信への合流では、要求の優先度が高くても既存の利用を終了しません。別の搬送波を要求し、空きチューナーがない場合は、従来どおり優先度に従って切り替えます。
- `tsmfRelTs` と `tsmfGroupId` を省略した場合は、各チャンネルのスキャンでヘッダーから相対 TS・ストリーム ID・グループ ID・搬送波数を取得し、`channels.json` に保存します。同じタイプ・経路・グループで同じ TLV を伝送する搬送波が必要数揃うと、追加のチューナーを使ってサービスをスキャンします。共有する TS のサービスは、他の搬送波が揃う前でもスキャンします。対応するチューナーの登録数が足りない場合は、ヘッダー情報を保存し、TLV のサービス取得は保留します。チャンネルスキャンでは、TS のサービスを伝送しない搬送波も BS4K のチャンネルとして追加します ([チャンネルスキャン](#チャンネルスキャン))。
- 搬送波の間のずれは、組み立てた TLV が正しくつながるかで判定します (遅延の差は約 0.5 秒まで)。判定するまでは出力しません。通常は 1 秒以内ですが、4 つ以上の搬送波では 10 秒ほどかかる場合があります。
- 搬送波のどれかが約 10 秒受信できない場合 (チューナーの起動を含む) や、組み立てられない状態が続いた場合は、ストリームを終了します。

```yaml
- name: TLV (1)
  type: BS4K
  route: CATV
  channel: '1'
  tsmfRelTs: 1
  tsmfGroupId: 8
- name: TLV (2)
  type: BS4K
  route: CATV
  channel: '2'
  tsmfRelTs: 1
  tsmfGroupId: 8
- name: TLV (3)
  type: BS4K
  route: CATV
  channel: '3'
  tsmfRelTs: 1
  tsmfGroupId: 8
```

#### route

チャンネルを受信する経路です。BS を衛星アンテナと CATV のトランスモジュレーションの両方で受信する場合などは、同じ放送を別の経路のチャンネルとしても設定できます。

サービスは、受信したストリーム (`networkId` と `transport_stream_id`) で受信経路と結び付けます。同じストリームを受信できるチャンネルが複数ある場合は、空いているチューナーがある経路で選局します (先にスキャンしたチャンネルを優先します)。各チャンネルで受信したストリームは `channels.json` (環境変数: `CHANNELS_DB_PATH`、既定: `services.json` と同じディレクトリ) に保存します。

### チャンネルスキャン

Web UI の「Channel Scan」(`PUT /api/config/channels/scan`) は、受信経路 (`route`) ごとにチャンネルを調べ、受信したサービスのネットワーク (original_network_id) でチャンネルのタイプを決めて channels.yml に追加します。地上波・BS・CS・BS4K が混ざる CATV も、1 回のスキャンで追加できます。

| ネットワーク | タイプ |
| --- | --- |
| `4` | BS |
| `6`, `7` | CS |
| `1`, `3`, `10` | SKY |
| TLV (MMT) | BS4K |
| `0x7880`~`0x7FE8` (地上波)、CATV のネットワーク (`0xFFF7`、`0xFFF9`、`0xFFFA`、`0xFFFD`、`0xFFFE`、`0xFFFF`。自主放送など) | GR |

それ以外のネットワークのストリームは追加しません。

調べるチャンネル (`source`) は次から選びます。

- `preset`: 受信経路ごとの既定のチャンネル (recpt1 や recisdb などのチャンネル名)
    - TER: `13`~`62`
    - SAT: `BS01_0`~`BS23_3`、`CS2`~`CS24`
    - CATV: `C13`~`C63`、`13`~`62`
    - HIKARI: `13`~`62`、`BS01_0`~`BS23_3`、`CS2`~`CS24`
- `dvbConf`: スキャンに使うチューナーの dvbv5-zap のチャンネル設定ファイル (`-c`) のすべてのチャンネル (DVB-C など、直接操作できないチャンネル設定ファイルも含む)
- `list`: 指定したチャンネル (`channels`)
- `format`: チャンネル名の書式 (`channelNameFormat`、例: `C{ch}`) と範囲

- スキャンには、受信経路のチューナーを使います。ISDB-T と ISDB-S のように種類の異なるチューナーがある場合は、受信できるまで、それぞれのチューナーで試します (受信経路のタイプ: TER は GR、SAT は BS / CS / BS4K / SKY、CATV と HIKARI はすべて)。1 つのチューナーで複数の放送を受信する場合は、チューナーの `types` に受信するタイプをすべて指定してください (CATV では `[GR, BS, CS, BS4K]` など)。
- スキャンでは、TLV 用でないチューナーでも TSMF の相対 TS を判別します。チャンネルにそのタイプの相対 TS が 1 つだけの場合は `tsmfRelTs` を追加します (どのチューナーでも受信できます)。同じタイプの相対 TS が複数ある場合は `tsmfRelTs` を追加せず、TLV 用のチューナーで判別します。
- 複数の搬送波で伝送する TLV (BS8K など) の搬送波は、サービスがなくても BS4K のチャンネルとして追加します (`tsmfRelTs` と `tsmfGroupId` は判別します)。
- スキャンしたチャンネルの、その受信経路の設定 (タイプにかかわらず) をスキャン結果で置き換えます。スキャンしないチャンネルや、ほかの受信経路の設定は残します。`refresh` を指定しない場合は、有効な設定があるチャンネルはスキャンせず、そのチャンネルの設定を残します。
- チャンネルは、タイプとチャンネル名の組み合わせで区別します。ほかの受信経路に同じタイプとチャンネル名の設定がある場合は、その設定を残し、スキャンしたチャンネルは追加しません。
