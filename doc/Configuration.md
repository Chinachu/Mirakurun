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
  types: # (GR|BS|CS|SKY)[]
    - GR
    - BS
    - CS
    - SKY
  # For chardev/dvb
  # "<template>" will be replaced with `commandVars[template]` or "(empty)" *@4.0.0~
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
  isDisabled: false # Boolean
```

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
  type: GR # Enum [GR|BS|CS|SKY]
  channel: '0' # String
  # Optional parameters below
  serviceId: 1234 # Integer - Services will be automatically scanned if not specified.
  tsmfRelTs: 1 # Number: 1~15
  commandVars: # Optional command variables *@4.0.0~
    satellite: EXAMPLE-SAT4A
    space: 0
    freq: 12345
    polarity: H
    exampleArg1: -arg0 -arg1=example
    exampleArg2: -arg2 "Can include spaces using quotes"
  isDisabled: false # Boolean
```
