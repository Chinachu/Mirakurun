import EventEmitter = require("eventemitter3");
import { StreamInfo } from "./common";

export interface StreamFilter extends EventEmitter {
    streamInfo: StreamInfo;
    get closed(): boolean;
    write(chunk: Buffer): void;
    end(): void;
    close(): void;
}
