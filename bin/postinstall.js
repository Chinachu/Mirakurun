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

const fs = require("fs");
const path = require("path");
const child_process = require("child_process");
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

if (process.platform === "linux" || process.platform === "darwin") {
    if (process.getuid() !== 0) {
        process.exit(0);
    }

    if (process.env.DOCKER === "YES") {
        console.log("Note: running in Docker.");
        process.exit(0);
    }

    // pm2
    const testFlight = child_process.execSync("pm2 -v", { encoding: "utf8" });
    console.log(testFlight);

    const logDir = path.join("/usr/local/var/log");
    child_process.execSync(`mkdir -vp ${logDir}`);

    // pm2 check
    const pm2Version = child_process.execSync("pm2 -v", { encoding: "utf8" }).trim();
    const pm2Expected = ">=2.4.0";
    if (semver.satisfies(pm2Version, pm2Expected) === true) {
        console.log("Version:", `pm2@${pm2Version}`, "[OK]");
    } else {
        console.error("Version:", `pm2@${pm2Version}`, "[NG]", "Expected:", pm2Expected);
        process.exit(1);
    }

    try {
        child_process.execSync(`pm2 startup`, {
            stdio: [
                null,
                process.stdout,
                process.stderr
            ]
        });
    } catch (e) {
        console.log("Caution: `pm2 startup` has failed. you can try fix yourself.");
    }

    child_process.execSync("pm2 start processes.json", {
        stdio: [
            null,
            process.stdout,
            process.stderr
        ]
    });

    child_process.execSync("pm2 save", {
        stdio: [
            null,
            process.stdout,
            process.stderr
        ]
    });
} else if (process.platform === "win32") {
    // winser check
    const winserVersion = child_process.execSync("winser -v", { encoding: "utf8" }).replace(/^[a-z]+ /, "").trim();
    const winserExpected = ">=1.0.3 <2.0.0";
    if (semver.satisfies(winserVersion, winserExpected) === true) {
        console.log("Version:", `winser@${winserVersion}`, "[OK]");
    } else {
        console.error("Version:", `winser@${winserVersion}`, "[NG]", "Expected:", winserExpected);
        process.exit(1);
    }

    // winser

    const dataDir = path.join(process.env.LOCALAPPDATA, "Mirakurun");
    if (fs.existsSync(dataDir) === false) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    const stdoutLogPath = path.join(dataDir, "stdout");
    const stderrLogPath = path.join(dataDir, "stderr");

    child_process.execFileSync(
        "winser.cmd",
        [
            "-i", "-a", "--startuptype", "auto",
            "--startcmd", `node.exe bin\\init.win32.js`,
            "--set", "AppPriority ABOVE_NORMAL_PRIORITY_CLASS",
            "--set", "Type SERVICE_WIN32_OWN_PROCESS",
            "--set", `AppStdout ${ stdoutLogPath }`,
            "--set", `AppStderr ${ stderrLogPath }`,
            "--env", `USERPROFILE=${ process.env.USERPROFILE }`,
            "--env", `LOCALAPPDATA=${ process.env.LOCALAPPDATA }`,
            "--env", "USING_WINSER=1"
        ],
        {
            stdio: [
                null,
                process.stdout,
                process.stderr
            ]
        }
    );
}
