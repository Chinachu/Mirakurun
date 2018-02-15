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

const colors = require("colors");

if (process.env["npm_config_global"] !== "true") {
    console.log("Note: add `-g` to install Mirakurun as Server!".yellow);
    process.exit(0);
}

const child_process = require("child_process");

if (process.platform === "linux" || process.platform === "darwin") {
    if (process.getuid() !== 0) {
        console.log("Note: `sudo npm install mirakurun -g --unsafe --production` to install Mirakurun as Server.".yellow);
        process.exit(0);
    }

    if (process.env.DOCKER === "YES") {
        console.log("Note: running in Docker.".yellow);
        process.exit(0);
    }
} else if (process.platform === "win32") {
    try {
        child_process.execSync("winser -r -x", {
            stdio: [
                null,
                process.stdout,
                null
            ]
        });
    } catch (e) {
    }
}
