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

    child_process.execSync("mkdir -vp /usr/local/etc/mirakurun");
    child_process.execSync("mkdir -vp /usr/local/var/log");
    child_process.execSync("mkdir -vp /usr/local/var/run");
    child_process.execSync("mkdir -vp /usr/local/var/db/mirakurun");

    child_process.execSync("cp -vn config/server.yml /usr/local/etc/mirakurun/server.yml");
    child_process.execSync("cp -vn config/tuners.yml /usr/local/etc/mirakurun/tuners.yml");
    child_process.execSync("cp -vn config/channels.yml /usr/local/etc/mirakurun/channels.yml");

    // pm2

    child_process.execSync("pm2 start processes.json", {
        stdio: [
            null,
            process.stdout,
            process.stderr
        ]
    });

    let platform = "";

    if (fs.existsSync("/usr/bin/systemctl") === true) {
        platform = "systemd";
    } if (fs.existsSync("/etc/redhat-release") === true) {
        platform = "centos";
    } else if (fs.existsSync("/etc/issue") === true) {
        const issue = fs.readFileSync("/etc/issue", { encoding: "utf-8" });
        if (/Ubuntu/.test(issue) === true) {
            platform = "ubuntu";
        }
    }

    child_process.execSync(`pm2 startup ${platform}`, {
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