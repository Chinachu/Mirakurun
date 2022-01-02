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
import * as os from "os";
import { Validator } from "ip-num/Validator";
import { IPv4, IPv6 } from "ip-num/IPNumber";
import { IPv4Prefix, IPv6Prefix } from "ip-num/Prefix";
import { IPv4CidrRange, IPv6CidrRange } from "ip-num/IPRange";
import _ from "./_";

export function getIPv4AddressesForListen(): string[] {

    const addresses = [];

    const interfaces = os.networkInterfaces();
    Object.keys(interfaces).forEach(k => {
        interfaces[k]
            .filter(a => {
                return (
                    a.family === "IPv4" &&
                    a.internal === false &&
                    isPermittedIPAddress(a.address) === true
                );
            })
            .forEach(a => addresses.push(a.address));
    });

    return addresses;
}

export function getIPv6AddressesForListen(): string[] {

    const addresses = [];

    const interfaces = os.networkInterfaces();
    Object.keys(interfaces).forEach(k => {
        interfaces[k]
            .filter(a => {
                return (
                    a.family === "IPv6" &&
                    a.internal === false &&
                    isPermittedIPAddress(a.address) === true
                );
            })
            .forEach(a => addresses.push(a.address + "%" + k));
    });

    return addresses;
}

export function isPermittedIPAddress(addr: string): boolean {

    const [isIPv4] = Validator.isValidIPv4String(addr);
    if (isIPv4) {
        const ipv4 = new IPv4CidrRange(new IPv4(addr), new IPv4Prefix(32));
        for (const rangeString of _.config.server.allowIPv4CidrRanges) {
            if (ipv4.inside(IPv4CidrRange.fromCidr(rangeString))) {
                return true;
            }
        }
    }

    const [isIPv6] = Validator.isValidIPv6String(addr);
    if (isIPv6) {
        const ipv6 = new IPv6CidrRange(new IPv6(addr), new IPv6Prefix(128));
        for (const rangeString of _.config.server.allowIPv6CidrRanges) {
            if (ipv6.inside(IPv6CidrRange.fromCidr(rangeString))) {
                return true;
            }
        }
    }

    return false;
}

export function isPermittedHost(url: string, allowedHostname?: string): boolean {

    const u = new URL(url);

    if (u.hostname === "localhost" || u.hostname === allowedHostname || isPermittedIPAddress(u.hostname) === true) {
        return true;
    }

    return false;
}
