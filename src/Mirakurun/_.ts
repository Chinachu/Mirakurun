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

import Event = require('./Event');
import Tuner = require('./Tuner');
import Channel = require('./Channel');
import Service = require('./Service');
import Program = require('./Program');

interface _ {
    event?: Event;
    tuner?: Tuner;
    channel?: Channel;
    service?: Service;
    program?: Program;
}

const _: _ = {};

export = _;