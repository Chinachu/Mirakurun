/*
   Copyright 2016 kanreisa

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
interface Status {
    epg: { [networkId: number]: boolean };
    streamCount: {
        tsFilter: number;
        decoder: number;
    };
    errorCount: {
        uncaughtException: number;
        unhandledRejection: number;
        bufferOverflow: number;
        tunerDeviceRespawn: number;
        decoderRespawn: number;
    };
    timerAccuracy: {
        last: number;
        m1: number[];
        m5: number[];
        m15: number[];
    };
}

const status: Status = {
    epg: {},
    streamCount: {
        tsFilter: 0,
        decoder: 0
    },
    errorCount: {
        uncaughtException: 0,
        unhandledRejection: 0,
        bufferOverflow: 0,
        tunerDeviceRespawn: 0,
        decoderRespawn: 0
    },
    timerAccuracy: {
        last: 0,
        m1: Array.apply(null, new Array(60)).map(Number.prototype.valueOf, 0),
        m5: Array.apply(null, new Array(60 * 5)).map(Number.prototype.valueOf, 0),
        m15: Array.apply(null, new Array(60 * 15)).map(Number.prototype.valueOf, 0)
    }
};

const tl = status.timerAccuracy;
let last: [number, number];

function tick() {
    // main loop
    const diff = process.hrtime(last); // nanoseconds
    tl.last = diff[0] * 1e9 + diff[1] - 1000000000;

    tl.m1.push(tl.last);
    tl.m5.push(tl.last);
    tl.m15.push(tl.last);

    tl.m1.shift();
    tl.m5.shift();
    tl.m15.shift();

    last = process.hrtime();
    setTimeout(tick, 1000);
}
setTimeout(() => last = process.hrtime(), 1000 * 9);
setTimeout(tick, 1000 * 10);

export default status;
