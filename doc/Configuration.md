# Configuration

* [server.yml](#serveryml)
* [tuners.yml](#tunersyml)
* [channels.yml](#channelsyml)

## server.yml

* Env: `SERVER_CONFIG_PATH`
* Docker Host (default): `/opt/mirakurun/config/server.yml`
* Linux (legacy): `/usr/local/etc/mirakurun/server.yml`

### Structure

```yaml
logLevel: 2 # integer -1: FATAL to 3: DEBUG
maxLogHistory: 1000 # integer (lines)
path: /var/run/mirakurun.sock # string or ~ (null) *Ignored in Docker
port: 40772 # integer or ~ (null) *Ignored in Docker
hostname: localhost
disableIPv6: false # boolean *Ignored in Docker
maxBufferBytesBeforeReady: 8388608 # integer (bytes)
eventEndTimeout: 1000 # integer (ms)
programGCInterval: 3600000 # integer (ms)
epgGatheringInterval: 1800000 # integer (ms)
epgRetrievalTime: 600000 # integer (ms)
logoDataInterval: 604800000 # integer (ms)
disableEITParsing: false # boolean
disableWebUI: false # boolean
allowIPv4CidrRanges: ["10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] # array of string
allowIPv6CidrRanges: ["fc00::/7"] # array of string
```

### Environment Variables (Docker)

```sh
HOSTNAME
LOG_LEVEL
MAX_LOG_HISTORY
MAX_BUFFER_BYTES_BEFORE_READY
EVENT_END_TIMEOUT
PROGRAM_GC_INTERVAL
EPG_GATHERING_INTERVAL
EPG_RETRIEVAL_TIME
LOGO_DATA_INTERVAL
DISABLE_EIT_PARSING
DISABLE_WEB_UI
ALLOW_IPV4_CIDR_RANGES
ALLOW_IPV6_CIDR_RANGES
```

## tuners.yml

* Env: `TUNERS_CONFIG_PATH`
* Docker Host (default): `/opt/mirakurun/config/tuners.yml`
* Linux (legacy): `/usr/local/etc/mirakurun/tuners.yml`

### Structure

```yaml
# array
- name: TUNER-NAME-FOR-IDENTIFICATION # string
  types: # enum
    - GR
    - BS
    - CS
    - SKY
  # for chardev/dvb
  command: cmd <channel> --arg1 --arg2 ... # string
  # for dvb
  dvbDevicePath: /dev/dvb/adapter/dvr/path # string
  # for multiplexing w/ remote Mirakurun
  remoteMirakurunHost: 192.168.x.x # string
  remoteMirakurunPort: 40772 # integer
  remoteMirakurunDecoder: false # boolean
  # below are optional
  decoder: cmd # string
  isDisabled: false # boolean
```

#### decoder

Specify the CAS processor command if needed.

```
# Reference: MPEG-2 TS Graph
+-------------+    +----------+    +---------+    +--------+
| TunerDevice | -> | TSFilter | -> | decoder | -> | (user) |
+-------------+    +----------+    +---------+    +--------+
               RAW           STRIPPED      DESCRAMBLED
```

```sh
# this is implementation example. for test only.
sudo npm install arib-b25-stream-test -g --unsafe-perm
```

## channels.yml

* Env: `CHANNELS_CONFIG_PATH`
* Docker Host (default): `/opt/mirakurun/config/channels.yml`
* Linux (legacy): `/usr/local/etc/mirakurun/channels.yml`

### Structure

```yaml
# array
- name: CHANNEL-NAME-FOR-IDENTIFICATION # string
  type: GR # enum [GR|BS|CS|SKY]
  channel: '0' # string
  # below are optional
  serviceId: 1234 # integer
  satellite: JCSAT4A # string: <satellite> in tuner command
  space: 0 # integer: <space> as tuning space number in tuner command (default: 0)
  freq: 12345 # number: <freq> in tuner command
  polarity: H # enum [H|V]
  tsmfRelTs: 1 # number: 1~15
  isDisabled: false # boolean
```

#### serviceId

Specify the Service ID (=SID) integer.
if not, services will scanned automatically.
