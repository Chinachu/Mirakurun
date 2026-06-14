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
import { LazyCaller } from "./common";
import * as regexp from "./regexp";

export function blur(): void {
    (document.activeElement as HTMLElement)?.blur();
}

export const setTitle = (() => {
    const lazy = new LazyCaller(100, 0, _setTitle);
    return lazy.caller.bind(this) as typeof _setTitle;
})();

export function _setTitle(title: string, loading?: boolean): void {

    if (!title) {
        return;
    }

    title = title.replace(regexp.squaredUnicode, "").replace(regexp.legacyAttributeFormat, "");

    if (!title) {
        return;
    }

    if (!loading) {
        const elements = document.querySelectorAll(".heading-title");
        elements.forEach(element => {
            element.classList.remove("bp5-skeleton");
            element.textContent = title;
        });
    }

    document.title = `${title.normalize("NFKC")} | Mirakurun`;
}

let _faviconElement: HTMLLinkElement;
export function setFavicon(src: string) {
    if (!_faviconElement) {
        _faviconElement = document.querySelector("link[rel*='icon']") as HTMLLinkElement;
    }
    if (_faviconElement) {
        _faviconElement.href = src;
    }
}

export function autoLink(text: string): string {
    return text
        .replace(regexp.epgHTTPLinkFormat, text => {
            let url = text.normalize("NFKC");
            if (!/^http/.test(url)) {
                url = `https://${url}`;
            }
            return `<a referrerpolicy="no-referrer" target="_blank" href="${url}" title="外部サイト">${text}</a>`;
        })
        .replace(regexp.epgXLinkFormat, (text, username) => {
            return text.replace(username,
                `<a referrerpolicy="no-referrer" target="_blank" href="https://x.com/${username.slice(1)}" title="X">${username}</a>`
            );
        })
        .replace(regexp.epgInstagramLinkFormat, (text, username) => {
            return text.replace(username,
                `<a referrerpolicy="no-referrer" target="_blank" href="https://instagram.com/${username.slice(1)}" title="Instagram">${username}</a>`
            );
        });
}
