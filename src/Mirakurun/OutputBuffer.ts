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
/** Retain only newly queued chunks and discard the oldest bytes above the limit.
 * Returns the retained byte count. Input chunks may be shared with other consumers.
 */
export function retainOutput(buffer: Buffer[], retainedCount: number, bytes: number, limit: number): number {
    if (retainedCount < buffer.length) {
        buffer.push(Buffer.concat(buffer.splice(retainedCount)));
    }
    let excess = bytes - limit;
    if (excess > 0) {
        let head = 0;
        while (head < buffer.length && buffer[head].length <= excess) {
            excess -= buffer[head++].length;
        }
        buffer.splice(0, head);
        if (excess > 0) {
            buffer[0] = buffer[0].subarray(excess);
        }
        return limit;
    }
    return bytes;
}
