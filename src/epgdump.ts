/*
   Copyright 2017 kanreisa

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
import * as stream from "stream";
import * as fs from "fs";
import * as path from "path";

if (process.argv.length < 3) {
    console.error("Mirakurun EPG Dump Test Program");
    console.error("Usage: mirakurun-epgdump src.ts dest.json");
    process.exit(1);
}

const force = process.argv[process.argv.length - 3] === "-f";
const src = path.resolve(process.cwd(), process.argv[process.argv.length - 2]);
const dest = path.resolve(process.cwd(), process.argv[process.argv.length - 1]);

console.log("src:", src);
console.log("dest:", dest);

if (fs.existsSync(src) === false) {
    console.error(`"${src}" is not exists.`);
    process.exit(1);
}
if (fs.existsSync(dest) === true && force === false) {
    console.error(`"${dest}" is exists.`);
    process.exit(1);
}

process.env.SERVER_CONFIG_PATH = path.resolve(__dirname, "../config/server.yml");
process.env.PROGRAMS_DB_PATH = dest;

import { TsStream } from "@chinachu/aribts";
import _ from "./Mirakurun/_";
import Event from "./Mirakurun/Event";
import Program from "./Mirakurun/Program";
import EPG from "./Mirakurun/EPG";
import * as config from "./Mirakurun/config";
import * as log from "./Mirakurun/log";

(<any> log).logLevel = log.LogLevel.INFO;
_.config.server = config.loadServer();
_.event = new Event();
_.program = new Program();
const epg = new EPG();

const size = fs.statSync(src).size;
let bytesRead = 0;
let events = 0;

const tsStream: stream.Transform = new TsStream();
const readStream = fs.createReadStream(src);

const transformStream = new stream.Transform({
    transform: function (chunk: Buffer, encoding: string, done: Function) {

        bytesRead += chunk.length;

        console.log("\u001b[2A");
        console.log(`reading - ${bytesRead} of ${size} [${Math.floor(bytesRead / size * 100)}%] (events=${events})`);

        this.push(chunk);
        done();
    },
    flush: done => {

        console.log("\u001b[2A");
        console.log(`reading - ${bytesRead} of ${size} [${Math.floor(bytesRead / size * 100)}%] (events=${events}) [done]`);
        console.timeEnd("read");

        setTimeout(finalize, 3500);
        done();
    }
});

console.log("");
console.time("read");
readStream.pipe(transformStream);
transformStream.pipe(tsStream);

tsStream.on("eit", (pid, data) => {
    epg.write(data);
    events = _.program.items.length;
});
tsStream.resume();

function finalize() {

    const programs = _.program.items;

    console.log("programs:", programs.length, "(events)");

    fs.writeFileSync(dest, JSON.stringify(programs, null, "  "));

    console.log(`saved to "${dest}".`);
    process.exit(0);
}
