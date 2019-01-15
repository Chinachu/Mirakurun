/*
   Copyright 2017 Yuki KAN

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
import { spawn, ChildProcess } from "child_process";
import { openSync } from "fs";
import * as latestVersion from "latest-version";
const pkg = require("../package.json");

if (process.env.DOCKER === "YES") {
    console.error("Error: running in Docker.");
    process.exit(1);
}
if (process.platform !== "win32" && process.getuid() !== 0) {
    console.error("Error: root please.");
    process.exit(1);
}
if (!pkg._resolved) {
    console.error("Error: incompatible environment. (installed from not npm?)");
    process.exit(1);
}

(async () => {

    const current = pkg.version as string;
    console.log("current:", current);

    const latest = await latestVersion("mirakurun");
    console.log("latest:", latest);

    if (current === latest) {
        console.log("already up to date.");
        process.exit(0);
    }
    if (current.split(".")[0] !== latest.split(".")[0]) {
        console.error("updater has aborted cause major version outdated.");
        process.exit(0);
    }

    console.log("updating...");

    const npm = spawnNpmInstall(latest);
    npm.on("exit", (code) => {
        if (code === 0) {
            console.log("updated successfully.");
            process.exit(0);
        } else {
            console.error("failed! reverting...");
            const npm = spawnNpmInstall(current);
            npm.on("exit", () => process.exit(1));
        }
    });
})();

function spawnNpmInstall(version: string): ChildProcess {

    let command = "npm";
    const args = [
        "install",
        `${pkg.name}@${version}`,
        "-g",
        "--production"
    ];
    if (process.platform === "win32") {
        command = "npm.cmd";
    } else {
        args.push("--unsafe-perm");
    }

    console.log(">", command, ...args);

    let out: number;
    if (process.env.UPDATER_LOG_PATH) {
        out = openSync(process.env.UPDATER_LOG_PATH, "a");
    }

    const npm = spawn(command, args, {
        detached: true,
        stdio: [
            "ignore",
            out || process.stdout,
            out || process.stderr
        ]
    });
    npm.unref();

    return npm;
}
