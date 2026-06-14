/*
   Copyright 2026 kanreisa

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
import * as regexp from "./regexp";

export async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

export function inRange<T = number>(value: T, min: T, max: T): boolean {
    return value >= min && value <= max;
}

export function getGlobalServiceId(networkId: number, serviceId: number): number {
    return parseInt(networkId + (serviceId / 100000).toFixed(5).slice(2), 10);
}

export function getIdWithHex(id: number): string {
    return `0x${id.toString(16).toUpperCase()} (${id})`;
}

export function textMatch(text: string, queryNormalized: string): boolean {
    if (normalizeText(text).includes(queryNormalized)) {
        return true;
    }
    return false;
}

export function normalizeText(text: string): string {
    return katakanaToHiragana(squaredUnicodeToBrackets(text).normalize("NFKC")).toLowerCase();
}

export function squaredUnicodeToBrackets(text: string): string {
    return text.replace(regexp.squaredUnicode, (s) => {
        return `[${s.normalize("NFKC")}]`;
    });
}

export function katakanaToHiragana(text: string): string {
    return text.replace(regexp.katakana, (s) => {
        const code = s.charCodeAt(0) - 0x60;
        return String.fromCharCode(code);
    });
}

export class LazyCaller<T extends Function> {
    caller: T;

    private _delayTimeout: NodeJS.Timeout;
    private _activate: null | any[] = null; // args
    private _running = false;

    /**
     * 遅延時間が経過するまでコールされなかった時に指定関数を実行
     * @param msDelay 最低遅延時間
     * @param msSleep 実行後待機時間
     * @param fn 実行関数 (Promise の場合は重複を避けて遅延実行する)
     */
    constructor(public msDelay: number, public msSleep: number, public fn: T) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias, unicorn/no-this-assignment
        const _lazy = this;

        this.caller = function lazyCaller(this: never, ...args: any[]) {
            if (_lazy._running) {
                _lazy._activate = args || [];
                return;
            }

            clearTimeout(_lazy._delayTimeout);
            _lazy._delayTimeout = setTimeout(async () => {
                _lazy._activate = null;
                _lazy._running = true;

                if (_lazy.fn) {
                    await Reflect.apply(_lazy.fn, this, args);
                }

                await sleep(_lazy.msSleep);

                _lazy._running = false;
                if (_lazy._activate && _lazy.caller) {
                    setTimeout(_lazy.caller.apply(this, _lazy._activate), 0);
                }
            }, _lazy.msDelay);
        } as any as T;
    }

    destroy() {
        clearTimeout(this._delayTimeout);
        this._activate = null;
        delete this.fn;
        delete this.caller;
    }
}

export function copyToClipboard(text: string) {
    // secure context ではないため execCommand を使用する
    const input = document.createElement("input");
    input.setAttribute("readonly", "readonly");
    input.setAttribute("value", text);
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    document.body.removeChild(input);
}
