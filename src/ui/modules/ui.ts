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
