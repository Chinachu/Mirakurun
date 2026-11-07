[**English**](Configuration.md) | [**日本語**](Configuration.ja.md)

# Configuration

- 🗒️[server.yml](#serveryml) - Server Settings
- 🗒️[tuners.yml](#tunersyml) - Tuner Settings
- 🗒️[channels.yml](#channelsyml) - Channel Settings

## ⚠️Security Considerations (FYI)

- Mirakurun is designed to be a LAN-only server.
- By default, access is restricted to private IP addresses.
- Access from arbitrary hostnames or domains is prohibited → **DNS Rebinding / CSRF protection**
  - `hostname`: Set the hostname to access the Web UI.
  - `allowOrigins`: Explicitly set allowed hostnames/domains if required.
- Multiple techniques are used to mitigate attack risks.
- Do not allow API access from all domains or deploy without a reverse proxy, as it may be vulnerable to:
  - Attacks reusing authenticated BASIC credentials or session data.
  - Although modern browsers offer protection, do not rely on them entirely.
  - HTTPS reverse proxies might bypass certain browser and Mirakurun safeguards, increasing risk → [Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
  - Instead, use VPN, SSH tunnels, or tunnel services.
    - Note: Some tunnel services require configuring `allowIPv4CidrRanges` to prevent third-party access.

> **DNS Rebinding Attack**: An attacker controls a domain and initially serves a legitimate site. After the DNS TTL expires, they switch it to point to their malicious server. This bypasses the browser’s same-origin policy and enables unauthorized access to a LAN server via the browser.

> **XSS/CSRF Attack**: An attacker embeds malicious code into a website to gain unauthorized access to a LAN server via the browser.

- Examples of attacks:
  - Execute arbitrary code via tuner commands
  - Inject malicious code into the server and turn it into a botnet
- The above are only a few examples; many others, exploiting browser or middleware vulnerabilities, are devised daily.
- With more web-based applications emerging, they can be as vulnerable to similar attacks as browsers. Exercise caution.

## 🗒️server.yml

📛 Partially supported in Web UI

### File Paths

- Environment Variable: `SERVER_CONFIG_PATH`
- Docker Host (Default): `/opt/mirakurun/config/server.yml`
- Linux (Legacy): `/usr/local/etc/mirakurun/server.yml`

### Server Settings List

| Property (🗒️server.yml) | Environment Variable (🐋Docker) | Type | Default | Description |
|------------|------------------|-------|-----------|------|
| `logLevel` | `LOG_LEVEL` | Integer | `2` | Log Level (`-1`: FATAL to `3`: DEBUG) |
| `maxLogHistory` | `MAX_LOG_HISTORY` | Integer | `1000` | Maximum number of log lines to retain |
| `path` | - | String, null | 🗒️`/var/run/mirakurun.sock` | Unix Socket Path **※Fixed to default in Docker** |
| `port` | - | Integer, null | `40772` | Server Port **※Fixed at `40772` on the container side in Docker** |
| `hostname` | `HOSTNAME` | String | `localhost` | Hostname |
| `disableIPv6` | - | Boolean | `false` | Disable IPv6 **※Always disabled in Docker** |
| `jobMaxRunning` | `JOB_MAX_RUNNING` | Integer | logical cores / 2, min 1, max 100 | Maximum number of jobs that can run simultaneously |
| `jobMaxStandby` | `JOB_MAX_STANDBY` | Integer | logical cores - 1, min 1, max 100 | Maximum number of jobs that can be prepared simultaneously |
| `maxBufferBytesBeforeReady` | `MAX_BUFFER_BYTES_BEFORE_READY` | Integer | `8388608` | Maximum buffer size before ready (bytes)<br>**※Increase if the beginning of the program is missing** |
| `eventEndTimeout` | `EVENT_END_TIMEOUT` | Integer | `1000` | Event end timeout (milliseconds)<br>**※Increase if program end is incorrectly detected** |
| `programGCJobSchedule` | `PROGRAM_GC_JOB_SCHEDULE` | String | `45 * * * *` | Program list GC schedule (cron-like format) |
| `epgGatheringJobSchedule` | `EPG_GATHERING_JOB_SCHEDULE` | String | `20,50 * * * *` | EPG gathering schedule (cron-like format) |
| `epgRetrievalTime` | `EPG_RETRIEVAL_TIME` | Integer | `600000` | EPG retrieval time (milliseconds) |
| `logoDataInterval` | `LOGO_DATA_INTERVAL` | Integer | `604800000` | Logo data update interval (milliseconds) |
| `disableEITParsing` | `DISABLE_EIT_PARSING` | Boolean | `false` | ⚠️Disable EIT parsing |
| `disableWebUI` | `DISABLE_WEB_UI` | Boolean | `false` | ⚠️Disable Web UI |
| `allowIPv4CidrRanges` | `ALLOW_IPV4_CIDR_RANGES` | String[] | `["10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]` | ⚠️Allowed IPv4 CIDR blocks |
| `allowIPv6CidrRanges` | `ALLOW_IPV6_CIDR_RANGES` | String[] | `["fc00::/7"]` | ⚠️Allowed IPv6 CIDR blocks |
| `allowOrigins` | `ALLOW_ORIGINS` | String[] | `["https://mirakurun-secure-contexts-api.pages.dev"]` | ⚠️🧪Allowed origins (experimental) |
| `allowPNA` | `ALLOW_PNA` | Boolean | `true` | 🧪[PNA](https://github.com/WICG/private-network-access)/[LNA](https://github.com/explainers-by-googlers/local-network-access) permission settings (experimental) |
| `tsplayEndpoint` | `TSPLAY_ENDPOINT` | String | `https://mirakurun-secure-contexts-api.pages.dev/tsplay/` | 🧪TSPlay endpoint (experimental) |
| `defaultTlvStreamFormat` | `DEFAULT_TLV_STREAM_FORMAT` | String | `tlv` | Output format of the TLV (MMT) channels for the stream requests without `format` (`ts` or `tlv`)<br>If `ts` is selected and no tuner for the channel has `tlvToTsDecoder` configured, HTTP 406 is returned |

## 🗒️tuners.yml

💯 Fully supported in Web UI

### File Path

- Environment Variable: `TUNERS_CONFIG_PATH`
- Docker Host (Default): `/opt/mirakurun/config/tuners.yml`
- Linux (Legacy): `/usr/local/etc/mirakurun/tuners.yml`

### Structure

```yaml
# Array
- name: TunerIdentificationName # String
  types: # (GR|BS|CS|SKY|BS4K)[]
    - GR
    - BS
    - CS
    - SKY
  routes: # (TER|SAT|CATV|HIKARI)[] - routes the tuner can receive. All routes if omitted.
    - TER
    - CATV
  # For chardev/dvb
  # "<template>" will be replaced with `commandVars[template]` or "(empty)" *@4.0.0~
  # "<route>" will be replaced with the route of the channel in lowercase (ter|sat|catv|hikari)
  command: cmd <channel> --arg1 --arg2 <exampleArg1> <exampleArg2>... # String
  # For dvb
  dvbDevicePath: /dev/dvb/adapter/dvr/path # String
  disableDvbDirect: false # Boolean
  # For multiplexing with remote Mirakurun
  remoteMirakurunHost: 192.168.x.x # String
  remoteMirakurunPort: 40772 # Integer
  remoteMirakurunDecoder: false # Boolean
  # Optional parameters below
  decoder: cmd # String
  tlvDecoder: cmd # String
  tlvToTsDecoder: cmd # String
  isDisabled: false # Boolean
```

`BS4K` has been added to the public `ChannelType` union. TypeScript consumers with exhaustive switches or `Record<ChannelType, ...>` mappings for the previous four types need to add a `BS4K` case or key. `GR`, `BS`, `CS` and `SKY` remain supported.

#### routes

The routes the tuner can receive. A channel is tuned only by the tuners whose `routes` include the `route` of the channel. If omitted, the tuner is treated as receiving all routes (same as before).

For example, specify `BS` in `types` and `CATV` in `routes` for a tuner receiving BS through CATV transmodulation. A tuner connected to the satellite antenna with `SAT` in `routes` is not used for the CATV channels.

#### DVB device direct access

For a tuner whose `command` is `dvbv5-zap`, Mirakurun tunes by accessing the DVB device directly instead of running the command. Tuning is faster because Mirakurun does not wait for a process to start and exit. To run the command as before, set `disableDvbDirect: true`.

This applies when the command name at the beginning of `command` (without the directory) is `dvbv5-zap`. So your own wrapper script named `dvbv5-zap`, such as `/opt/bin/dvbv5-zap`, is not run either.

##### Supported options

The following `dvbv5-zap` options are read and used. The long forms (such as `--adapter`) can also be used.

- `-a`, `-f`, `-d`: adapter, frontend and demux numbers (the dvr uses the same number as the demux)
- `-c`: channels file (required)
- `-P`: output all PIDs (required)
- `-I DVBV5`: format of the channels file
- `-l`, `-S`, `-W`, `-U`: satellite LNBf, DiSEqC and SCR/Unicable
- `-w`: LNA

The output options (`-r`, `-o -`) and the display options (`-s`, `-v`, `-N`) are ignored.

For satellite, the LNB power, 22kHz tone, DiSEqC and frequency conversion are handled in the same way as `dvbv5-zap`, and `LNB`, `POLARIZATION` and `SAT_NUMBER` in the channels file are used in the same way. If the LNBf is specified neither by `-l` nor by `LNB` in the channels file, the frequency is not converted and the LNB is not powered.

Supported delivery systems are ISDB-T and ISDB-S.

`<route>` can be used in `-c` (such as `-c ./conf/dvbv5_channels_<route>.conf`). In this case, the channels file of each of `routes` (all routes if omitted) is read, and the file of the route of the channel is used for tuning.

##### When the command is run

In any of the following cases, the command is run as before instead of accessing the device directly. The reason is logged as a warning at startup.

- An option or value not listed above (such as `-t` or `-I ZAP`) is specified.
- `-c` or `-P` is not specified.
- The arguments other than options are not just `<channel>`.
- A number in the options has a leading zero (`dvbv5-zap` reads it as octal).
- `dvbDevicePath` differs from `/dev/dvb/adapter<a>/dvr<d>` given by `-a` and `-d`.
- The channels file has unsupported or duplicate properties, or a channel without `FREQUENCY`.
- The channels file has lines that `dvbv5-zap` reads differently (no space before `=`, trailing spaces in a value, CRLF line endings).

If the channels file is edited after startup and can no longer be read, the command is run for each tuning until the file is fixed.

##### Differences from running the command

While tuning directly, the following differ from running the command.

- The tuner's `command` in the API is `/dev/dvb/adapter<n> <channel>` and its `pid` is `null`.
- To speed up the next tuning, the frontend is kept open for 1 second after the tuner is released.
- If tuning fails (e.g. the device cannot be opened or the channel is not found), the stream request fails without retrying.
- If tuning fails 3 times in a row because the device does not exist, the tuner is treated as faulty and is not used until Mirakurun is restarted. A restart is also required after reconnecting a USB tuner.

#### decoder

Specify the CAS processing command as needed.

```
# Reference: MPEG-2 TS flow
+-------------+    +----------+    +---------+    +--------+
| TunerDevice | -> | TSFilter | -> | decoder | -> | (user) |
+-------------+    +----------+    +---------+    +--------+
               RAW           STRIPPED      DESCRAMBLED
```

```sh
# This is an implementation example. For testing only.
sudo npm install arib-b25-stream-test -g --unsafe-perm
```

#### tlvDecoder / tlvToTsDecoder

These are used instead of `decoder` for TLV (MMT) channels of any type. Both can be specified with arguments (quote the ones including spaces).

- `tlvDecoder`: CAS processing command that takes TLV and outputs TLV
- `tlvToTsDecoder`: command that takes TLV and outputs MPEG-2 TS

```
# Reference: TLV flow
+-------------+    +-----------+    +------------+    +----------------+    +--------+
| TunerDevice | -> | TLVFilter | -> | tlvDecoder | -> | tlvToTsDecoder | -> | (user) |
+-------------+    +-----------+    +------------+    +----------------+    +--------+
               TLV             TLV               TLV                   TS
```

With `format=tlv`, the stream APIs output TLV without `tlvToTsDecoder`. With `format=ts`, only the tuners with `tlvToTsDecoder` are used to output TS. Without `format`, `defaultTlvStreamFormat` is followed. 406 is returned for the format that can not be output.

If `tlvToTsDecoder` keeps failing to start, the stream is closed instead of outputting TLV. `tlvDecoder` passes through the input as `decoder` does.

## 🗒️channels.yml

💯 Fully supported in Web UI

### File Path

- Environment Variable: `CHANNELS_CONFIG_PATH`
- Docker Host (Default): `/opt/mirakurun/config/channels.yml`
- Linux (Legacy): `/usr/local/etc/mirakurun/channels.yml`

### Structure

```yaml
# Array
- name: ChannelIdentificationName # String
  type: GR # Enum [GR|BS|CS|SKY|BS4K]
  channel: '0' # String
  # Optional parameters below
  route: TER # Enum [TER|SAT|CATV|HIKARI] - receiving route. `TER` for GR, `SAT` for others if omitted.
  serviceId: 1234 # Integer - Services will be automatically scanned if not specified.
  tsmfRelTs: 1 # Number: 1~15 - relative TS number of TSMF (for both TS and TLV). Detected by the service scan on the tuners for TLV (the types including BS4K, or tlvDecoder / tlvToTsDecoder configured) if not specified. Required for the tuners only for TS
  tsmfGroupId: 1 # Number: 1~255 - the group of the carriers transmitting a TLV (channel bonding of CATV). The channels of the same value are the carriers of the group. Detected by the service scan on the tuners for TLV if not specified together with tsmfRelTs
  format: tlv # Enum [ts|tlv] - the format detected by the service scan if not specified (before the scan, tlv for BS4K, ts for others)
  commandVars: # Optional command variables *@4.0.0~
    satellite: EXAMPLE-SAT4A
    space: 0
    freq: 12345
    polarity: H
    exampleArg1: -arg0 -arg1=example
    exampleArg2: -arg2 "Can include spaces using quotes"
  isDisabled: false # Boolean
```

#### tsmfRelTs

The relative TS number of the channel multiplexed by TSMF. The relative stream carrying TLV in extended TSMF can also be specified.

If not specified, all the relative streams in use, and TS or TLV for each, are detected from the TSMF headers by the service scan, and the services are scanned for each relative stream (saved in `channels.json`). The services are newly registered only by the scan of the channel without services, as before. The streams of the services and the programs receive the relative stream of the service. Like `format`, they are detected only when the tuner of the scan has the type `BS4K` or `tlvDecoder` / `tlvToTsDecoder`. Specify `tsmfRelTs` to receive a channel of TSMF by the tuners only for TS.

The stream of the channel (`/api/channels/{type}/{channel}/stream`) accepts the query `tsmfRelTs` to specify the relative stream. Without it, the relative stream of `tsmfRelTs` of channels.yml (the stream as received if not specified) is output as before, for the remote Mirakurun receiving it. The stream as received of a channel whose TSMF is detected is TS, even for the type `BS4K` (unless `format` is specified). When the relative stream of a service is unknown, the relative stream of the most slots (the smaller number if the same) of the network of the service (of all if none) is received. The relative streams detected are not received by the remote tuners (the remote Mirakurun outputs its own relative stream). If there are only the remote tuners, the stream as received is received as before (503 for the relative stream detected specified by the query `tsmfRelTs`).

#### format

The format of the data received on the channel. `tlv` for TLV (MMT).

If not specified, the format is detected from the data received by the service scan, and saved in `channels.json`. It is detected only when the tuner of the scan has the type `BS4K` or `tlvDecoder` / `tlvToTsDecoder` (not to add any work to the environments only for TS). The streams for viewing and recording do not detect and use the format saved (not to delay the start of the streams of TS). Before the scan, `tlv` for the type `BS4K`, `ts` for the others.

`format` is for the stream of the channel (the relative stream of `tsmfRelTs`, or the stream as received if not specified). When the relative streams of TSMF are detected without `tsmfRelTs`, each relative stream is received in the format detected.

#### tsmfGroupId

Specify this when a TLV is transmitted by multiple carriers of CATV (channel bonding). The channels of the same `type` and `tsmfGroupId` are the carriers of the group, tuned at the same time by the different tuners to assemble the TLV. Any channel of the group outputs the same TLV.

- Tuners as many as the carriers are needed. The tuners of the carriers are shown in `/api/tuners` as the users `<user ID>#carrier<n>`.
- Requests for the same carriers share the tuners with EPG acquisition and other streams. Joining the same reception does not stop existing users, even at a higher priority. Requests for other carriers follow the usual priority rules when no tuner is free.
- When `tsmfRelTs` and `tsmfGroupId` are omitted, each channel scan saves the relative streams, stream IDs, group ID and carrier count from the headers in `channels.json`. Once all carriers of the same type, route and group carrying the same TLV have been discovered, service scanning uses the additional tuners. TS services sharing a carrier are scanned even before the other carriers have been discovered. If fewer compatible local tuners are registered than required, header information is saved and TLV service scanning is deferred. The channel scan adds the carriers without TS services as channels of BS4K ([Channel Scan](#channel-scan)).
- The skew of the carriers is found by checking the TLV assembled (the difference of the delays up to about 0.5 seconds). Nothing is output until it is found, usually within a second, but it may take about 10 seconds for 4 or more carriers.
- The stream is closed when a carrier is not received for about 10 seconds (including starting the tuner) or the TLV can not be assembled.

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

The route to receive the channel. The same broadcast can also be configured as a channel of another route, such as BS received both through a satellite antenna and through CATV transmodulation.

A service is associated with the channels by the stream received (`networkId` and `transport_stream_id`). If multiple channels can receive the same stream, the route with an available tuner is tuned (the channel scanned first is preferred). The stream received on each channel is saved in `channels.json` (environment variable: `CHANNELS_DB_PATH`, default: in the same directory as `services.json`).

### Channel Scan

"Channel Scan" of the Web UI (`PUT /api/config/channels/scan`) scans the channels of a receiving route (`route`), decides the type of each channel by the network of the services received (original_network_id), and adds them to channels.yml. CATV mixing terrestrial, BS, CS and BS4K is also added by one scan.

| Network | Type |
| --- | --- |
| `4` | BS |
| `6`, `7` | CS |
| `1`, `3`, `10` | SKY |
| TLV (MMT) | BS4K |
| `0x7880`-`0x7FE8` (terrestrial), the networks of CATV (`0xFFF7`, `0xFFF9`, `0xFFFA`, `0xFFFD`, `0xFFFE`, `0xFFFF`, such as the community channels) | GR |

The streams of the other networks are not added.

The channels to scan (`source`):

- `preset`: the channels of the route (the names of the tuner commands such as recpt1, recisdb)
    - TER: `13`-`62`
    - SAT: `BS01_0`-`BS23_3`, `CS2`-`CS24`
    - CATV: `C13`-`C63`, `13`-`62`
    - HIKARI: `13`-`62`, `BS01_0`-`BS23_3`, `CS2`-`CS24`
- `dvbConf`: all the channels of the channel config files of dvbv5-zap (`-c`) of the tuners used for the scan (including the files not for DVB device direct access, such as DVB-C)
- `list`: the channels specified (`channels`)
- `format`: the format of the channel names (`channelNameFormat`, e.g. `C{ch}`) and the range

- The tuners of the route are used. If the route has the tuners of the different kinds (such as ISDB-T and ISDB-S), each channel is tried by them until received (once by the tuners of the same `types`) (the types of the route: TER: GR, SAT: BS / CS / BS4K / SKY, CATV and HIKARI: any). The tuners of a remote Mirakurun are tried by each type, because they receive only the channels of the types configured on the remote. For a tuner receiving multiple broadcasts, specify all the types to receive in `types` (such as `[GR, BS, CS, BS4K]` for CATV).
- The scan detects the relative streams of TSMF also on the tuners not for TLV. If the type has only one relative stream on the channel, `tsmfRelTs` is added (any tuner receives it). If the type has more than one, `tsmfRelTs` is not added and the tuners for TLV detect them. The relative streams whose services are not received are also counted by the network of the header (logged, added by scanning again).
- The carriers of a TLV transmitted by multiple carriers (such as BS8K) are added as channels of BS4K without the services (`tsmfRelTs` and `tsmfGroupId` are detected).
- The entries of the channels scanned on the route (of any type) are replaced with the result. The entries of the channels not scanned and of the other routes remain. Without `refresh`, the channels with an enabled entry are not scanned and their entries remain.
- The channels are distinguished by the type and the channel name. If another route has an enabled entry of the same type and channel name, the entry remains and the channel scanned is not added.
