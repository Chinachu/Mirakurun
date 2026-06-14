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
export type ScheduleId = string;
export type ScheduleTask = () => void;

const map: Record<ScheduleId, [number, ScheduleTask]> = {};
let count = 0;
let intervalId: ReturnType<typeof setInterval>;

export function setSchedule(time: number, task: ScheduleTask): ScheduleId {
    const id = (++count).toString(10);
    map[id] = [time, task];

    console.debug("at", "setSchedule()", id, map[id]);

    return id;
}

export function clearSchedule(id: ScheduleId): void {
    console.debug("at", "clearSchedule()", id, map[id]);

    delete map[id];
}

export function init(interval = 1000) {
    if (intervalId) {
        clearInterval(intervalId);
    }
    intervalId = setInterval(() => run(), interval);
}

export function deinit() {
    if (intervalId) {
        clearInterval(intervalId);
    }
}

function run() {
    const now = Date.now();

    for (const id in map) {
        const [time, task] = map[id];
        if (time <= now) {
            console.debug("at", "run()", id, map[id]);

            delete map[id];
            task();
        }
    }
}
