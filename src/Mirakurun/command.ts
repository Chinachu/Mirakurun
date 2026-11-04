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
// コマンドの文字列の解釈 (Web UI でも同じく解釈するため、他のモジュールに依存しない)

export function parseCommandForSpawn(cmdString: string): { command: string; args: string[] } {
    let inQuote = false;
    let quoteChar = "";
    let current = "";
    const parts: string[] = [];

    // Parse the command string character by character
    for (let i = 0; i < cmdString.length; i++) {
        const char = cmdString[i];

        if ((char === `"` || char === `'`) && (!inQuote || char === quoteChar)) {
            // Toggle quote state if we encounter a quote character
            inQuote = !inQuote;
            quoteChar = inQuote ? char : "";
        } else if (char === " " && !inQuote) {
            // Space outside of quotes indicates a new part
            if (current) {
                parts.push(current);
                current = "";
            }
        } else {
            // Add character to the current part
            current += char;
        }
    }

    // Add the last part if there is one
    if (current) {
        parts.push(current);
    }

    if (parts.length === 0) {
        throw new Error("Invalid command string");
    }

    // First part is the command, the rest are arguments
    const result: { command: string; args: string[] } = {
        command: parts[0],
        args: parts.slice(1)
    };

    return result;
}
