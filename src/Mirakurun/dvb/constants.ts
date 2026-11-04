/*
   Copyright 2026 kanreisa

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/

// Linux DVB API (uapi `linux/dvb/frontend.h`, `linux/dvb/dmx.h`) の定数

/** `DTV_*` (struct dtv_property の cmd) */
export const DTV = {
    TUNE: 1,
    FREQUENCY: 3,
    BANDWIDTH_HZ: 5,
    INVERSION: 6,
    SYMBOL_RATE: 8,
    DELIVERY_SYSTEM: 17,
    ISDBT_PARTIAL_RECEPTION: 18,
    ISDBT_SOUND_BROADCASTING: 19,
    ISDBT_SB_SUBCHANNEL_ID: 20,
    ISDBT_SB_SEGMENT_IDX: 21,
    ISDBT_SB_SEGMENT_COUNT: 22,
    ISDBT_LAYERA_FEC: 23,
    ISDBT_LAYERA_MODULATION: 24,
    ISDBT_LAYERA_SEGMENT_COUNT: 25,
    ISDBT_LAYERA_TIME_INTERLEAVING: 26,
    ISDBT_LAYERB_FEC: 27,
    ISDBT_LAYERB_MODULATION: 28,
    ISDBT_LAYERB_SEGMENT_COUNT: 29,
    ISDBT_LAYERB_TIME_INTERLEAVING: 30,
    ISDBT_LAYERC_FEC: 31,
    ISDBT_LAYERC_MODULATION: 32,
    ISDBT_LAYERC_SEGMENT_COUNT: 33,
    ISDBT_LAYERC_TIME_INTERLEAVING: 34,
    GUARD_INTERVAL: 38,
    TRANSMISSION_MODE: 39,
    ISDBT_LAYER_ENABLED: 41,
    STREAM_ID: 42,
    LNA: 61
} as const;

/** `INVERSION_AUTO`, `FEC_AUTO`, `QAM_AUTO`, `GUARD_INTERVAL_AUTO`, `TRANSMISSION_MODE_AUTO`, `INTERLEAVING_AUTO` */
export const INVERSION_AUTO = 2;
export const FEC_AUTO = 9;
export const QAM_AUTO = 6;
export const GUARD_INTERVAL_AUTO = 4;
export const TRANSMISSION_MODE_AUTO = 2;
export const INTERLEAVING_AUTO = 1;

/** `enum fe_delivery_system` */
export const SYS = {
    DVBS: 5,
    DVBS2: 6,
    ISDBT: 8,
    ISDBS: 9,
    TURBO: 17
} as const;

/** 衛星の伝送方式 (libdvbv5 の `dvb_fe_is_satellite()` と同じ) */
export const SATELLITE_SYSTEMS: readonly number[] = [SYS.DVBS, SYS.DVBS2, SYS.TURBO, SYS.ISDBS];

/** `enum fe_sec_voltage` */
export const SEC_VOLTAGE = {
    V13: 0,
    V18: 1,
    OFF: 2
} as const;

/** `enum fe_sec_tone_mode` */
export const SEC_TONE = {
    ON: 0,
    OFF: 1
} as const;

/** `enum fe_sec_mini_cmd` */
export const SEC_MINI = {
    A: 0,
    B: 1
} as const;

/** `DTV_LNA` で自動にする値 */
export const LNA_AUTO = 0xFFFFFFFF;

/** `enum dmx_input`, `enum dmx_output`, `enum dmx_ts_pes` と `DMX_IMMEDIATE_START` */
export const DMX_IN_FRONTEND = 0;
export const DMX_OUT_TS_TAP = 2;
export const DMX_PES_OTHER = 20;
export const DMX_IMMEDIATE_START = 4;

/** すべての PID を通す PES フィルターの PID */
export const PID_ALL = 0x2000;

export const MAX_DTV_STATS = 4;
