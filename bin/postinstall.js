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

if (process.env["npm_config_global"] !== "true") {
    process.exit(0);
}

const semver = require("semver");
const pkg = require("../package.json");

// node check
if (semver.satisfies(process.version, pkg.engines.node) === true) {
    console.log("Version:", `node@${process.version}`, "[OK]");
} else {
    console.error("Version:", `node@${process.version}`, "[NG]", "Expected:", pkg.engines.node);
    process.exit(1);
}

// init
if (process.getuid() !== 0) {
    process.exit(0);
}

if (process.env.DOCKER === "YES") {
    console.log("Note: running in Docker.");
    process.exit(0);
}
