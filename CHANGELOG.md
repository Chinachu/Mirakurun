# Mirakurun ChangeLog

see [Commit Logs](https://github.com/Chinachu/Mirakurun/commits/master) to check all.

## 3.9.0 (2021-xx-xx)

Performance improvements, fixes for memory leaks and bugs related to EPG processing, etc.

### Server Changes

- **config/server**: Add `disableWebUI` (Env: `DISABLE_WEB_UI` for Docker) to disable Web UI.
- **config/server**: Change several default values based on typical usage.
  - `programGCInterval`: `900000` (15 mins) → `3600000` (1 hour)
  - `epgGatheringInterval`: `900000` (15 mins) → `3600000` (30 mins)
  - `logoDataInterval`: `86400000` (1 day) → `604800000` (7 days)
- **config/server**: Remove `overflowTimeLimit`.
- **ts-filter**: Remove own overflow handling as it no longer makes sense.
- **ts-filter**: Fix memory leak when comparing CRC of broken PAT packet processing. (bug)
- **ts-filter**: Fix a problem in which the _close() function sometimes didn't call properly when the tuner was intercepted. (bug)
- **ts-filter**: Change EIT\[p/f\] information to use in EPG.
- **tuner-device**: Fixed a problem which the command didn't respawn ​correctly when it terminated unexpectedly. (bug)
- **epg**: Add support for multiple EIT types.
- **epg**: Fix wrong event group processing. (bug)
- **epg**: Add support for event relay.
- **epg**: Add support for multi track audios.
- **epg**: Improve performance of parsing start_time of events.
- **epg**: Change to run asynchronously to reduce load.
- **program**: Add event group type as `type` to `db.ProgramRelatedItem` of `db.Program`.
- **program**: Fixed a problem in the implementation of conflict detection. (bug)
- **program**: Reduced the frequent repeated update events.
- **program**: Removed the `audio` property and added the `audios` property to support multi track audios. (**breaking change**)
- **program**: Fix program overlapping when re-scheduled. (bug)
- **program**: Removed the `redefine` event and added the `remove` event. (**breaking change**)
- **api/iptv**: Fixed a problem with Kodi 19's IPTV feature that caused channel selection to take a long time. [#101](https://github.com/Chinachu/Mirakurun/pull/101)
- **api/getLogoImage**: Add `Cache-Control` header to cache logo images.
- **api/restart**: Improved the restart speed on Docker. (approx. 2 secs)
- **rpc**: Added a WebSocket RPC interface. (experimental)
- **ui**: Now using RPC interface.
- **ui/status**: Fix "EPG Gathering Network IDs" hex strings to upper case.
- **ui/status**: Fix handle tuner updates to correctly. (bug) [#109](https://github.com/Chinachu/Mirakurun/pull/109)
- **ui/config**: Add "EPG Gathering Interval" setting in Config/Server.
- **ui/heart**: Add confirmation before accessing opencollective. [#106](https://github.com/Chinachu/Mirakurun/issues/106)

### Client Changes

- Add [AbortSignal](https://nodejs.org/api/globals.html#class-abortsignal) option for `getChannelStream()`, `getServiceStreamByChannel()` `getServiceStream()`, `getProgramStream()`.
- Fix set priority correctly. (bug)

### Docker Changes

- Update base image to `node:16.12.0-buster-slim`.
- Fixed the exit signal handling properly.
- When a `SIGHUP` is received in a container, only the node process can be restarted quickly.

### Other Changes

- **package**: Drop engine support `node@12`.
- **package**: Update dependencies.
- Reimplemented certain processes in C++.

## 3.8.0 (2021-08-10)

Logo support enhanced.

### Server Changes

- **config/server**: Add `logoDataInterval` to suppress parsing logo data frequently.
- **service**: Save the each logo data to separate file instead of json db.
- **ts-filter**: Add support for BS/CS logo. [#17](https://github.com/Chinachu/Mirakurun/issues/17)
- **ui**: Add service list in "Status".

### Client Changes

- Add missing `type` definition in `Service`.

### Docker Changes

- Set env `NODE_ENV=production` by default.

### Other Changes

- **package**: Update dependencies.

## 3.7.1 (2021-08-06)

Bug fixes and improvements to memory usage, etc.

### Server Changes

- **node**: Removed `--max_old_space_size` flag.
- **db**: Improved performance of the save (write).
- **epg**: Fixed a bug where the EPG would not update if it was stopped for several days.
- **epg**: Improved memory usage.
- **epg**: Improved EPG gathering behavior.
- **program**: Improved performance and memory usage.

### Docker Changes

- Update base image to `node:16.6.1-buster-slim`.
- Set env `MALLOC_ARENA_MAX=2` by default.
- **docker-compose**: Set container_name to `mirakurun`.
- **docker-compose**: Set default network name to `mirakurun`.

### Other Changes

- **package**: Add engine support `node@16`.
- **package**: Drop engine support `node@10`.
- **package**: Update dependencies.
- **tsconfig**: Change target `es2017` → `es2019`.

## 3.7.0 (2021-07-24)

Added IPTV support and improved behavior regarding EPG refresh, improved UX, etc.

### Server Changes

- **epg**: Improved to perform refresh at an interval based on the previous refresh time when restarted.
- **epg**: Improved to detects broadcast off. The system does not attempt to refresh the EPG when broadcast is off.
- **api**: \[`services`\] Add `epgReady`, `epgUpdatedAt` properties.
- **api**: \[`config/channels/scan`\] Renamed options.
  - `registerOnDisabled` → `setDisabledOnAdd`
  - `registerMode` → `scanMode`
- **api**: \[`config/channels/scan`\] Fixed a bug that would change an enabled channel to disabled on `setDisabledOnAdd` is `true`.
- **api**: \[`config/channels/scan`\] Add `dryRun` option.
- **api**: \[`iptv`\] Implemented M3U playlist and XMLTV endpoints for IPTV.
- **api**: \[`iptv`\] Implemented additional endpoints for Plex Media Server.
- **ui**: Add "Connection Guide".
- **ui**: Scroll to bottom when adding a new item.

### Docker Changes

- Update base image to `node:14.17.3-buster-slim`.

### Other Changes

- **munin-plugins**: Removed. please use [mirakurun-munin-plugins](https://github.com/Chinachu/mirakurun-munin-plugins) instead.
- Update dependencies.

## 3.6.0 (2021-07-02)

Performance improvements and new features.

### Server Changes

- **server**: Add support for processing multiple frames (TSMF). [#90](https://github.com/Chinachu/Mirakurun/pull/90)
- **server**: Add support for Cross-Origin Resource Sharing (CORS).
- **ts-filter**: Minor performance improvements.
- **api**: \[`config/channels/scan`\] Add support 4 slots for transponders in BS. [#93](https://github.com/Chinachu/Mirakurun/pull/93)
- **ui**: Add "Special Thanks" (heart).

### Docker Changes

- Update base image to `node:14.17.1-buster-slim`.

### Other Changes

- Remove deprecated Mirakurun-UI from Readme. [#85](https://github.com/Chinachu/Mirakurun/pull/85)
- Fix webpack error on Windows. [#87](https://github.com/Chinachu/Mirakurun/pull/87)
- Update dependencies.

## 3.5.0 (2021-01-11)

This is **Important Update** for any devices.

- ✅ Improved Performance
- ✅ Improved Reliability
- ✅ Fixed Critical Bug

### Server Changes

- **program**: Change timing of save to data file to 10 seconds for reduce I/O usage.
- **ts-decoder**: Implemented `decoder` command auto-heal, path-through fallback. (new feature)
- **ts-filter**: Use `stream.Transform` instead of `stream.Duplex`.
- **ts-filter**: Make drop on error packet to fix broken TS output. (bug)
- **ts-filter**: Fix high CPU usage on waiting.
- **ts-filter**: Improve performance.
- **tuner-device**: Add `<freq>` and `<polarity>` to tuner command. [#77](https://github.com/Chinachu/Mirakurun/issues/77)
- **tuner-device**: Improve performance.

### Docker Changes

- Update base image to `node:14.15.4-buster-slim`.

## 3.4.1 (2020-12-28)

### Server Changes

- **api**: \[`config/channels/scan`\] Fix a incorrect default parameters. [#82](https://github.com/Chinachu/Mirakurun/issues/82)
- **api**: \[`config/channels/scan`\] Fix a timing of request timeout.

## 3.4.0 (2020-12-25)

Happy Holidays.

- **docker**: Update base image to `node:14.15.3-buster-slim`.

### Server Changes

- **server**: Add `hostname` config for allowing access with specific hostname.
- **server**: Fix timing of request timeout.
- **ui**: Add `hostname` config editor.
- **ui**: Add link to API Docs (Swagger UI).
- **api**: \[`config/channels/scan`\] Support BS/CS types. [#79](https://github.com/Chinachu/Mirakurun/pull/79)
- **api**: \[`tuners`\] Add `url` property to each `User` state.
- **api**: \[`tuners`\] Add `streamSetting` property to each `User` state.
- **api**: \[`tuners`\] Add `streamInfo` property to each `User` state for checking packet drop count.
- **api**: \[`channels/*/stream`, `services/*/stream`, `programs/*/stream`\] Add `X-Mirakurun-Tuner-User-ID` response header.
- **misc**: Rename `satelite` → `satellite`.

### Dependencies

- @fluentui/react: `^7.121.11` → `^7.155.3`
- eventemitter3: `^4.0.4` → `^4.0.7`
- express-openapi: `^6.0.0` → `^7.2.0`
- glob: `^7.1.6`
- js-yaml: `^3.14.0` → `^3.14.1`
- openapi-types: `^1.3.5` → `^7.0.1`
- react: `^16.13.1` → `^16.14.0`
- react-dom: `^16.13.1` → `^16.14.0`
- semver: `^7.3.2` → `^7.3.4`
- swagger-ui-dist: `^3.27.0` → `^3.28.0`
- tail: `^2.0.4` → `^2.1.0`
- (typescript): `^3.9.6` → `^4.1.3`

## 3.3.1 (2020-08-08)

- **docker**: fixed a bug the Log Level cannot be changed. [#78](https://github.com/Chinachu/Mirakurun/issues/78)
- **docker**: improve pcscd reliability.
  - now it will retry starting pcscd if not running correctly.
- **docker**: update base image to `node:14.7.0-buster-slim`.

## 3.3.0 (2020-08-02)

- **docker**: add arch `arm32v7`, `arm64v8`.

## 3.2.0 (2020-07-09)

- bug fix and add `disableEITParsing` config.

### Server Changes

- **docker**: fix wrong filename - `services.yml` → `services.json`, `programs.yml` → `programs.json`.
- **config**: add `disableEITParsing` (server). [#49](https://github.com/Chinachu/Mirakurun/issues/49)

### Dependencies

- @fluentui/react: `^7.121.4` → `^7.121.11`
- swagger-ui-dist: `^3.27.0` → `^3.28.0`
- (typescript): `^3.9.5` → `^3.9.6`

## 3.1.1 (2020-06-29)

- bug fix and update dependencies.

### Server Changes

- **server**: fix parsing wrong header (Origin).

### Dependencies

- @fluentui/react: `^7.121.0` → `^7.121.4`
- js-yaml: `^3.13.1` → `^3.14.0`
- morgan: `^1.9.1` → `1.10.0`
- opencollective-postinstall: `^2.0.1` → `2.0.3`
- semver: `^7.1.3` → `^7.3.2`
- source-map-support: `^0.5.16` → `^0.5.19`
- swagger-ui-dist: `^3.25.0` → `^3.27.0`
- tail: `^2.0.3` → `^2.0.4`

## 3.1.0 (2020-06-24)

UI added.

### Server Changes

- **config**: update default `channels.yml`.
- **api**: \[Restart API\] add Docker support.
- **ui**: added. (beta)

### Dependencies

- express-openapi: `^3.7.0` → `^6.0.0`
- react: `^16.13.1`
- react-dom: `^16.13.1`
- @fluentui/react: `^7.121.0`
- stream-http: `^3.1.1`
- eventemitter3: `^4.0.4`
- (typescript): `^3.7.5` → `^3.9.5`

## 3.0.0 (2020-06-16)

Enhanced Docker, DVB support.

- **docker**: pcscd included.
- **docker**: DVBv5 Tools included.
- **docker**: auto install `arib-b25-stream-test`.
- **munin-plugins**: docker (host) support.

### Server Changes

- **config**: add auto tuners configuration for DVB (ISDB-T, ISDB-S) devices.
- **ts-filter**: change default value of `maxBufferBytesBeforeReady` from `3MB` to `8MB`. [#67](https://github.com/Chinachu/Mirakurun/pull/67)
- **tuner-device**: send `SIGKILL` to kill if using `dvbv5-zap`.

## 2.15.2 (2020-04-26)

- **package**: update node version to `^10.15.0 < 11 || ^12 || ^14`.
  - note: dropped node@13 support.
- **docker**: update base image to `node:14.0.0-slim`.

## 2.15.1 (2020-04-26)

- nothing changed about server and clients.
- **munin-plugins**: fix wrong Shebang (CRLF to LF). [#66](https://github.com/Chinachu/Mirakurun/issues/66)

## 2.15.0 (2020-04-19)

- **package**: update node version to `^10.15.0 < 11 || ^12 || ^13`.
  - note: dropped node@8 support.
- **docker**: official build is now resumed.
  - _(very sorry for stopped few months)_

### Dependencies

- latest-version: `^3.1.0` → `^5.1.0`
- (gulp): _(removed)_

## 2.14.0 (2020-02-17)

- **package**: updates node version to `^8.17.0 < 9 || ^10.15.0 < 11 || ^12.14.0 < 13`.

### Server Changes

- **server**: catch `unhandledRejection`.
- **status**: add `unhandledRejection` errorCount.

### Client Changes

- improved stability and bug fixes.

### Dependencies

- openapi-types: `^1.3.5`
- aribts: `^1.3.4` → `^1.3.5`
- body-parser: `^1.18.3` → `^1.19.0`
- colors: `^1.3.3` → `^1.4.0`
- dotenv: `^7.0.0` → `^8.2.0`
- express: `^4.16.4` → `^4.17.1`
- semver: `^5.6.0` → `^7.1.3`
- swagger-ui-dist: `^3.21.0` → `^3.25.0`
- tail: `^2.0.2` → `^2.0.3`
- (typescript): `2.7.2` → `^3.7.5`

## 2.13.0 (2019-11-12)

Improved EPG processing performance. fixed unreliable codes.

- **package**: add support node@12

### Server Changes

- **ts-filter**: added EIT version check.
- **tuner-device** / **remote**: fixed missing default value of `remoteMirakurunPort` to `40772`.

## 2.12.0 (2019-11-05)

Improved startup stability. fixed stack trace for TypeScript codes.

### Server Changes

- **server**: await network up. [#60](https://github.com/Chinachu/Mirakurun/issues/60)

### Dependencies

- source-map-support: `^0.5.16`

## 2.11.0 (2019-05-12)

- **docker**: fixed something wrong.

### Server Changes

- **program**: improve performance. [#55](https://github.com/Chinachu/Mirakurun/pull/55)
- **ts-filter**: drop the chunk when the buffer overflows. [#57](https://github.com/Chinachu/Mirakurun/issues/57) [#58](https://github.com/Chinachu/Mirakurun/pull/58)

### Dependencies

- js-yaml: `^3.12.2` → `^3.13.1`

## 2.10.1 (2019-04-08)

### Server Changes

- **ts-filter**: fix unexpected PAT CRC [#53](https://github.com/Chinachu/Mirakurun/pull/53)

## 2.10.0 (2019-03-21)

### Server Changes

- **status**: add more property for diagnostics.

## 2.9.0 (2019-03-14)

- **package**: Activating Open Collective [#45](https://github.com/Chinachu/Mirakurun/pull/45)

### Server Changes

- **db**: improve error handling. [#48](https://github.com/Chinachu/Mirakurun/issues/48)
- **db**: added integrity check. [#35](https://github.com/Chinachu/Mirakurun/issues/35)
- **tuner**: fix EPIPE error occurred by decoder.kill [#46](https://github.com/Chinachu/Mirakurun/pull/46)
- **tuner-device**: fix duplicate function call of _kill() [#47](https://github.com/Chinachu/Mirakurun/pull/47)

### Dependencies

- opencollective: `^1.0.3`
- opencollective-postinstall: `^2.0.1`
- dotenv: `^6.2.0` → `^7.0.0`
- swagger-ui-dist: `^3.20.5` → `^3.21.0`
- js-yaml: `^3.12.1` → `^3.12.2`
- sift: `5.1.0` → `^7.0.1`
- tail: `^1.4.0` → `^2.0.2`

## 2.8.4 (2019-01-30)

### Server Changes

- **api**: \[Channel Scan API\] support sort by non-integer channel string. [#42](https://github.com/Chinachu/Mirakurun/pull/42/commits/cdd8a258ab6711853bf3570ae64c501c05a2f189)

### Dependencies

- dotenv: `^6.1.0` → `^6.2.0`
- express-openapi: `^3.6.0` → `^3.7.0`
- js-yaml: `^3.12.0` → `^3.12.1`

## 2.8.3 (2019-01-15)

### Server Changes

- **updater**: fix update failure. (please note: this fixes effective for later than this version.)

## 2.8.2 (2019-01-15)

- **install**: fix wrong expression to detect global install.

## 2.8.1 (2019-01-14)

### Server Changes

- **debug**: use [swagger-ui-dist](https://www.npmjs.com/package/swagger-ui-dist) instead of [swagger-ui](https://www.npmjs.com/package/swagger-ui).

### Dependencies

- swagger-ui-dist: `^3.20.5`
- swagger-ui: _(removed)_

## 2.8.0 (2019-01-03)

- use `--unsafe-perm` instead of `--unsafe`.

### Server Changes

- **node**: change `--max_old_space_size=256` to `--max_old_space_size=512`.
- **log**: env `LOG_STDOUT`, `LOG_STDERR` are not used anymore.
- **install**: add way to install **not** using `--unsafe-perm`.
- **cli**: add `init` command to init as service manually.

## 2.7.7 (2019-01-03)

### Server Changes

- **log**: fix comply http logs to log level setting.  [#41](https://github.com/Chinachu/Mirakurun/issues/41)

## 2.7.6 (2019-01-02)

### Server Changes

- **install**: fix missing `colors` dependency.

### Dependencies

- colors: `^1.3.3`

## 2.7.5 (2018-12-25)

### Server Changes

- **security**: allow referrer from `localhost`.
- **epg**: fix garbled parsing in extended description. [#26](https://github.com/Chinachu/Mirakurun/issues/26) [#40](https://github.com/Chinachu/Mirakurun/pull/40)

### Dependencies

- body-parser: `^1.17.1` → `^1.18.3`
- express-openapi: `^3.0.3` → `^3.6.0`
- js-yaml: `^3.8.4` → `^3.12.0`
- morgan: `^1.7.0` → `^1.9.1`
- semver: `^5.3.0` → `^5.6.0`
- tail: `^1.2.1` → `^1.4.1`

## 2.7.4 (2018-11-02)

### Server Changes

- **epg**: fix crash on epg gathering.

### Dependencies

- aribts: `1.3.3` → `^1.3.4`

## 2.7.2 (2018-10-19)

- **package**: add support node@10
- **build**: use `rimraf` instead of `gulp-del`
- **test**: add (dummy)

### Server Changes

- **ts-filter**: add padding to PAT with `0xff`. [#33](https://github.com/Chinachu/Mirakurun/issues/33) [#34](https://github.com/Chinachu/Mirakurun/pull/34)
- **tuner**: fix takeover strategy to lower priority first. [#31](https://github.com/Chinachu/Mirakurun/commit/3549d4d1994c07d415fb160faa7fc2e6bd4dbae0)
- **debug**: allow non-root users.
- **debug**: use `dotenv`.

### Dependencies

- express: `^4.15.2` → `^4.16.4`
- express-openapi: `^1.4.0` → `^3.0.3`
- sift: `^5.0.0` → `5.1.0`

## 2.7.0 (2018-02-17)

### Server Changes

- **remote**: add multiplexing feature w/ remote Mirakurun(s).

## 2.6.1 (2018-02-15)

...[Commit Logs before 2.6.1](https://github.com/Chinachu/Mirakurun/commits/877abea7af239804868ed39dc28d896d230e6c27)...
