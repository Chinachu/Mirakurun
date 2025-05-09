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
