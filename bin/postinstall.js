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

if (process.env["npm_config_global"] !== "true") {
    process.exit(0);
}

const fs = require("fs");
const path = require("path");
const child_process = require("child_process");

// init

if (process.platform === "linux" || process.platform === "darwin") {
    if (process.getuid() !== 0) {
        process.exit(0);
    }
    const prefix = "/usr/local";
    const configDir = path.join(prefix, "etc/mirakurun");
    const dataDir = path.join(prefix, "var/db/mirakurun");
    const logDir = path.join(prefix, "var/log");

    child_process.execSync(`mkdir -vp ${configDir}`);
    child_process.execSync(`mkdir -vp ${dataDir}`);
    child_process.execSync(`mkdir -vp ${logDir}`);

    const serverConfigPath = path.join(configDir, "server.yml");
    const tunersConfigPath = path.join(configDir, "tuners.yml");
    const channelsConfigPath = path.join(configDir, "channels.yml");

    if (fs.existsSync(serverConfigPath) === false) {
        copyFileSync("config/server.yml", serverConfigPath);
    }
    if (fs.existsSync(tunersConfigPath) === false) {
        copyFileSync("config/tuners.yml", tunersConfigPath);
    }
    if (fs.existsSync(channelsConfigPath) === false) {
        copyFileSync("config/channels.yml", channelsConfigPath);
    }

    // pm2

    if (process.env.DOCKER === "YES") {
        console.log("Note: running in Docker.");
        process.exit(0);
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
    const configDir = path.join(process.env.USERPROFILE, ".Mirakurun");
    const dataDir = path.join(process.env.LOCALAPPDATA, "Mirakurun");

    if (fs.existsSync(configDir) === false) {
        fs.mkdirSync(configDir);
    }
    if (fs.existsSync(dataDir) === false) {
        fs.mkdirSync(dataDir);
    }

    const serverConfigPath = path.join(configDir, "server.yml");
    const tunersConfigPath = path.join(configDir, "tuners.yml");
    const channelsConfigPath = path.join(configDir, "channels.yml");

    if (fs.existsSync(serverConfigPath) === false) {
        copyFileSync("config\\server.win32.yml", serverConfigPath);
    }
    if (fs.existsSync(tunersConfigPath) === false) {
        copyFileSync("config\\tuners.win32.yml", tunersConfigPath);
    }
    if (fs.existsSync(channelsConfigPath) === false) {
        copyFileSync("config\\channels.win32.yml", channelsConfigPath);
    }

    // winser

    const stdoutLogPath = path.join(dataDir, "stdout");
    const stderrLogPath = path.join(dataDir, "stderr");

    child_process.execFileSync(
        "winser.cmd",
        [
            "-i", "-a", "--startuptype", "delayed",
            "--startcmd", `node.exe bin\\init.win32.js`,
            "--set", "AppPriority ABOVE_NORMAL_PRIORITY_CLASS",
            "--set", "Type SERVICE_WIN32_OWN_PROCESS",
            "--set", `AppStdout ${ stdoutLogPath }`,
            "--set", `AppStderr ${ stderrLogPath }`,
            "--env", `LOG_STDOUT=${ stdoutLogPath }`,
            "--env", `LOG_STDERR=${ stderrLogPath }`,
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

function copyFileSync(src, dest) {
    fs.writeFileSync(dest, fs.readFileSync(src));
}