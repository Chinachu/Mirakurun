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

if (process.platform !== 'win32') {
    process.exit(1);
}

const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;

const proc = require('../processes.json').apps[0];
const configDir = path.join(process.env.USERPROFILE, '.Mirakurun');
const dataDir = path.join(process.env.LOCALAPPDATA, 'Mirakurun');

for (const key in proc.env) {
    setEnv(key, proc.env[key]);
}

const args = [
    path.resolve(__dirname, '..', proc.script.replace(/\//g, '\\')),
    proc.node_args,
    ...process.argv.slice(2)
];

console.log('configDir:', configDir);
console.log('dataDir:', dataDir);

const stdoutLogPath = path.join(dataDir, 'stdout');
const stderrLogPath = path.join(dataDir, 'stderr');

const stdout = fs.createWriteStream(stdoutLogPath);
const stderr = fs.createWriteStream(stderrLogPath);

setEnv('SERVER_CONFIG_PATH', path.join(configDir, 'server.yml'));
setEnv('TUNERS_CONFIG_PATH', path.join(configDir, 'tuners.yml'));
setEnv('CHANNELS_CONFIG_PATH', path.join(configDir, 'channels.yml'));
setEnv('SERVICES_DB_PATH', path.join(dataDir, 'services.json'));
setEnv('PROGRAMS_DB_PATH', path.join(dataDir, 'programs.json'));
setEnv('LOG_STDOUT', stdoutLogPath);
setEnv('LOG_STDERR', stderrLogPath);

const node = spawn('node.exe', args);

node.stdout.pipe(stdout);
node.stdout.pipe(process.stdout);
node.stderr.pipe(stderr);
node.stderr.pipe(process.stderr);

function setEnv(name, value) {
    process.env[name] = process.env[name] || value;
}