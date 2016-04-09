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
'use strict';

if (process.env['npm_config_global'] !== 'true') {
    process.exit(0);
}

const fs = require('fs');
const child_process = require('child_process');

// init

if (process.platform === 'linux' || process.platform === 'darwin') {
    if (process.getuid() !== 0) {
        process.exit(0);
    }

    child_process.execSync('mkdir -vp /usr/local/etc/mirakurun');
    child_process.execSync('mkdir -vp /usr/local/var/log');
    child_process.execSync('mkdir -vp /usr/local/var/run');
    child_process.execSync('mkdir -vp /usr/local/var/db/mirakurun');

    child_process.execSync('cp -vn config/server.yml /usr/local/etc/mirakurun/server.yml');
    child_process.execSync('cp -vn config/tuners.yml /usr/local/etc/mirakurun/tuners.yml');
    child_process.execSync('cp -vn config/channels.yml /usr/local/etc/mirakurun/channels.yml');

    // pm2

    child_process.execSync('pm2 start processes.json', {
        stdio: [
            null,
            process.stdout,
            process.stderr
        ]
    });

    child_process.execSync('pm2 startup', {
        stdio: [
            null,
            process.stdout,
            process.stderr
        ]
    });

    child_process.execSync('pm2 save', {
        stdio: [
            null,
            process.stdout,
            process.stderr
        ]
    });
} else if (process.platform === 'win32') {
    const base = `${ process.env.HOME }\\.Mirakurun`;
    const data = `${ process.env.LOCALAPPDATA }\\Mirakurun`;

    fs.existsSync(base) === false && fs.mkdirSync(base);
    fs.existsSync(data) === false && fs.mkdirSync(data);

    fs.existsSync(`${ base }\\server.yml`) === false && copy('config\\server.win32.yml', `${ base }\\server.yml`);
    fs.existsSync(`${ base }\\tuners.yml`) === false && copy('config\\tuners.win32.yml', `${ base }\\tuners.yml`);
    fs.existsSync(`${ base }\\channels.yml`) === false && copy('config\\channels.win32.yml', `${ base }\\channels.yml`);

    // winser

    child_process.execFileSync(
        'winser.cmd',
        [
            '-i', '-a', '--startuptype', 'delayed',
            '--startcmd', `node.exe bin\\init.win32.js`,
            '--set', 'AppPriority ABOVE_NORMAL_PRIORITY_CLASS',
            '--set', 'Type SERVICE_WIN32_OWN_PROCESS',
            '--env', `HOMEDRIVE=${ process.env.HOMEDRIVE }`,
            '--env', `HOMEPATH=${ process.env.HOMEPATH }`,
            '--env', `LOCALAPPDATA=${ process.env.LOCALAPPDATA }`
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

function copy(src, dest) {
    fs.createReadStream(src).pipe(fs.createWriteStream(dest));
}