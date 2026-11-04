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
// libdvbv5 と同じく文字列を比べる (C の strcasecmp() などは ASCII の英字だけを大文字と小文字で区別しない)

export function toAsciiLowerCase(str: string): string {
    return str.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function toAsciiUpperCase(str: string): string {
    return str.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) - 32));
}
