/** カタカナ */
export const katakana = /[\u30A1-\u30F6]/ug;

/** Unicode 囲み文字 (四角形) */
export const squaredUnicode = /[\u{1F130}-\u{1F14E}\u{1F201}-\u{1F23B}]/ug;

/** Unicode 囲み文字 (属性用) */
export const enclosedAttributeUnicode = /[\u{1F14D}-\u{1F14E}\u{1F210}-\u{1F222}]/ug;

/** レガシー属性フォーマット */
export const legacyAttributeFormat = /(?:[\[［][新生無][\]］]|\([二字]\)|[\[【]無料[\]】])/g;

/** EPG オートリンク用 */
export const epgHTTPLinkFormat = /(?:(https?:\/\/[\x21-\x7e]+)|(ｈｔｔｐｓ?：／／[\uFF01-\uFF5E]+)|(www\.[\x21-\x7e]+))/gi;

/** EPG オートリンク用 */
export const epgXLinkFormat = /(?:Twitter|Ｔｗｉｔｔｅｒ|X|Ｘ)[\s\S]{0,14}([@＠][\da-z_]+)/gi

/** EPG オートリンク用 */
export const epgInstagramLinkFormat = /(?:Instagram|Ｉｎｓｔａｇｒａｍ|インスタグラム)[\s\S]{0,14}([@＠][\da-z_]+)/gi
