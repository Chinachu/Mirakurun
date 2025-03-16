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
import * as apid from "../../api";
import Event from "./Event";
import Tuner from "./Tuner";
import Channel from "./Channel";
import Service from "./Service";
import Program from "./Program";
import Server from "./Server";

interface Shared {
    readonly config: {
        server?: apid.ConfigServer;
        channels?: apid.ConfigChannels;
        tuners?: apid.ConfigTuners;
    };
    readonly configIntegrity: {
        channels: string;
    };
    event?: Event;
    tuner?: Tuner;
    channel?: Channel;
    service?: Service;
    program?: Program;
    server?: Server;
}

export const _: Shared = {
    config: {},
    configIntegrity: {
        channels: ""
    }
};

export default _;
