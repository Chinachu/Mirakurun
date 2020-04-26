# Mirakurun ChangeLog

see [Commit Logs](https://github.com/Chinachu/Mirakurun/commits/master) to check all.

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
