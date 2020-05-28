# Configuration

* [server.yml](#serveryml)
* [tuners.yml](#tunersyml)
* [channels.yml](#channelsyml)

## server.yml

```sh
sudo mirakurun config server
```

### Structure

```yaml
logLevel: 2 # integer -1: FATAL to 3: DEBUG
maxLogHistory: 1000 # integer (lines)
path: /var/run/mirakurun.sock # string or ~ (null)
port: 40772 # integer or ~ (null)
disableIPv6: false # boolean
highWaterMark: 25165824 # integer (bytes)
overflowTimeLimit: 30000 # integer (ms)
maxBufferBytesBeforeReady: 8388608 # integer (bytes)
eventEndTimeout: 1000 # integer (ms)
programGCInterval: 900000 # integer (ms)
epgGatheringInterval: 900000 # integer (ms)
epgRetrievalTime: 600000 # integer (ms)
```

## tuners.yml

```sh
sudo mirakurun config tuners
```

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

```sh
sudo mirakurun config channels
```

### Structure

```yaml
# array
- name: CHANNEL-NAME-FOR-IDENTIFICATION # string
  type: GR # enum [GR|BS|CS|SKY]
  channel: '0' # string
  # below are optional
  serviceId: 1234 # integer
  satelite: JCSAT4A # string for <satelite> in tuner command
  space: 0 # integer: <space> as tuning space number in tuner command (default: 0)
  isDisabled: false # boolean
```

#### serviceId

Specify the Service ID (=SID) integer.
if not, services will scanned automatically.
