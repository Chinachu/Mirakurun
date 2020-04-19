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
"use strict";

if (process.env["npm_config_global"] !== undefined && process.env["npm_config_global"] !== "true") {
    process.exit(0);
}

const execSync = require("child_process").execSync;

if (process.platform === "linux" || process.platform === "darwin") {
    if (process.getuid() !== 0 || process.env.DOCKER === "YES") {
        process.exit(0);
    }

    execSync("pm2 stop mirakurun-server", {
        stdio: [
            null,
            process.stdout,
            process.stderr
        ]
    });

    execSync("pm2 delete mirakurun-server", {
        stdio: [
            null,
            process.stdout,
            process.stderr
        ]
    });
} else if (process.platform === "win32") {
    execSync("winser -r -x -s", {
        stdio: [
            null,
            process.stdout,
            process.stderr
        ]
    });
}
