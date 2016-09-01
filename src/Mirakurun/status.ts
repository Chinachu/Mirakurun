/*
   Copyright 2016 Yuki KAN

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
"use strict";

interface Status {
    epg: { [networkId: number]: boolean };
    errorCount: {
        bufferOverflow: number;
        tunerDeviceRespawn: number;
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
    errorCount: {
        bufferOverflow: 0,
        tunerDeviceRespawn: 0
    },
    timerAccuracy: {
        last: 0,
        m1: [],
        m5: [],
        m15: []
    }
};

const tl = status.timerAccuracy;
let last = Date.now();

function tick() {
    // main loop
    tl.last = Date.now() - last - 1000;

    tl.m1.push(tl.last);
    tl.m5.push(tl.last);
    tl.m15.push(tl.last);

    if (tl.m1.length > 60) {
        tl.m1.shift();
    }
    if (tl.m5.length > 60 * 5) {
        tl.m5.shift();
    }
    if (tl.m15.length > 60 * 15) {
        tl.m15.shift();
    }

    last = Date.now();
    setTimeout(tick, 1000);
}
setTimeout(tick, 1000);

export default status;