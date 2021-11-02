/*
   Copyright 2021 kanreisa

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
import { Operation } from "express-openapi";
import Service from "../../Service";
import _ from "../../_";

const GENRE_LV1: { [key: number]: string } = {
    0x0: "ニュース／報道",
    0x1: "スポーツ",
    0x2: "情報／ワイドショー",
    0x3: "ドラマ",
    0x4: "音楽",
    0x5: "バラエティ",
    0x6: "映画",
    0x7: "アニメ／特撮",
    0x8: "ドキュメンタリー/教養",
    0x9: "劇場／公演",
    0xA: "趣味／教育",
    0xB: "福祉",
    0xC: "予備",
    0xD: "予備",
    0xE: "拡張",
    0xF: "その他"
};

const GENRE_LV2: { [key: number]: string } = {
    0x00: "定時・総合",
    0x01: "天気",
    0x02: "特集・ドキュメント",
    0x03: "政治・国会",
    0x04: "経済・市況",
    0x05: "海外・国際",
    0x06: "解説",
    0x07: "討論・会談",
    0x08: "報道特番",
    0x09: "ローカル・地域",
    0x0A: "交通",
    0x0F: "その他",
    0x10: "スポーツニュース",
    0x11: "野球",
    0x12: "サッカー",
    0x13: "ゴルフ",
    0x14: "その他の球技",
    0x15: "相撲・格闘技",
    0x16: "オリンピック・国際大会",
    0x17: "マラソン・陸上・水泳",
    0x18: "モータースポーツ",
    0x19: "マリン・ウィンタースポーツ",
    0x1A: "競馬・公営競技",
    0x1F: "その他",
    0x20: "芸能・ワイドショー",
    0x21: "ファッション",
    0x22: "暮らし・住まい",
    0x23: "健康・医療",
    0x24: "ショッピング・通販",
    0x25: "グルメ・料理",
    0x26: "イベント",
    0x27: "番組紹介・お知らせ",
    0x2F: "その他",
    0x30: "国内ドラマ",
    0x31: "海外ドラマ",
    0x32: "時代劇",
    0x3F: "その他",
    0x40: "国内ロック・ポップス",
    0x41: "海外ロック・ポップス",
    0x42: "クラシック・オペラ",
    0x43: "ジャズ・フュージョン",
    0x44: "歌謡曲・演歌",
    0x45: "ライブ・コンサート",
    0x46: "ランキング・リクエスト",
    0x47: "カラオケ・のど自慢",
    0x48: "民謡・邦楽",
    0x49: "童謡・キッズ",
    0x4A: "民族音楽・ワールドミュージック",
    0x4F: "その他",
    0x50: "クイズ",
    0x51: "ゲーム",
    0x52: "トークバラエティ",
    0x53: "お笑い・コメディ",
    0x54: "音楽バラエティ",
    0x55: "旅バラエティ",
    0x56: "料理バラエティ",
    0x5F: "その他",
    0x60: "洋画",
    0x61: "邦画",
    0x62: "アニメ",
    0x6F: "その他",
    0x70: "国内アニメ",
    0x71: "海外アニメ",
    0x72: "特撮",
    0x7F: "その他",
    0x80: "社会・時事",
    0x81: "歴史・紀行",
    0x82: "自然・動物・環境",
    0x83: "宇宙・科学・医学",
    0x84: "カルチャー・伝統文化",
    0x85: "文学・文芸",
    0x86: "スポーツ",
    0x87: "ドキュメンタリー全般",
    0x88: "インタビュー・討論",
    0x8F: "その他",
    0x90: "現代劇・新劇",
    0x91: "ミュージカル",
    0x92: "ダンス・バレエ",
    0x93: "落語・演芸",
    0x94: "歌舞伎・古典",
    0x9F: "その他",
    0xA0: "旅・釣り・アウトドア",
    0xA1: "園芸・ペット・手芸",
    0xA2: "音楽・美術・工芸",
    0xA3: "囲碁・将棋",
    0xA4: "麻雀・パチンコ",
    0xA5: "車・オートバイ",
    0xA6: "コンピュータ・ＴＶゲーム",
    0xA7: "会話・語学",
    0xA8: "幼児・小学生",
    0xA9: "中学生・高校生",
    0xAA: "大学生・受験",
    0xAB: "生涯教育・資格",
    0xAC: "教育問題",
    0xAF: "その他",
    0xB0: "高齢者",
    0xB1: "障害者",
    0xB2: "社会福祉",
    0xB3: "ボランティア",
    0xB4: "手話",
    0xB5: "文字（字幕）",
    0xB6: "音声解説",
    0xBF: "その他",
    // 0xC0: "予備",
    // 0xD0: "予備",
    0xE0: "BS/地上デジタル放送用番組付属情報",
    0xE1: "広帯域CSデジタル放送用拡張",
    0xE2: "衛星デジタル音声放送用拡張",
    0xE3: "サーバー型番組付属情報",
    0xE4: "IP 放送用番組付属情報",
    0xF0: "その他",
    0xFF: "その他"
};

const GENRE_UNBS: { [key: number]: string } = {
    // lv1=14, lv2=0, un1=0 BS デジタル放送用番組付属情報
    0x00: "中止の可能性あり",
    0x01: "延長の可能性あり",
    0x02: "中断の可能性あり",
    0x03: "同一シリーズの別話数放送の可能性あり", // 地上デジタルテレビジョン放送で使用
    0x04: "編成未定枠",
    0x05: "繰り上げの可能性あり",
    // lv1=14, lv2=0, un1=1
    0x10: "中断ニュースあり",
    0x11: "当該イベントに関連する臨時サービスあり"
};

const GENRE_UNCS: { [key: number]: string } = {
    // lv1=14, lv2=1
    // un1=0(スポーツ)
    0x00: "テニス",
    0x01: "バスケットボール",
    0x02: "ラグビー",
    0x03: "アメリカンフットボール",
    0x04: "ボクシング",
    0x05: "プロレス",
    0x0F: "その他",
    // un1=1(洋画), 2(邦画)
    0x10: "アクション",
    0x11: "SF/ファンタジー",
    0x12: "コメディー",
    0x13: "サスペンス/ミステリー",
    0x14: "恋愛/ロマンス",
    0x15: "ホラー/スリラー",
    0x16: "ウエスタン",
    0x17: "ドラマ/社会派ドラマ",
    0x18: "アニメーション",
    0x19: "ドキュメンタリー",
    0x1A: "アドベンチャー/冒険",
    0x1B: "ミュージカル/音楽映画",
    0x1C: "ホームドラマ",
    0x1D: "青春/学園/アイドル",
    0x1E: "任侠/時代劇",
    0x1F: "その他"
};

function getGenreStrings(genres) {
    let strGenre = "";
    if (genres.lv1 === 14) {
        if (genres.lv2 === 0) {
            // BS 番組特性指示
            strGenre = GENRE_UNBS[genres.un1 * 16 + genres.un2];
        } else if (genres.lv2 === 1) {
            // CS独自ジャンル
            if (genres.un1 === 0) {
                strGenre = "スポーツ(" + GENRE_UNCS[genres.un2] + ")";
            } else if (genres.un1 === 1) {
                strGenre = "洋画(" + GENRE_UNCS[16 + genres.un2] + ")";
            } else if (genres.un1 === 2) {
                strGenre = "邦画(" + GENRE_UNCS[16 + genres.un2] + ")";
            } else {
                // strGenre = "0x" + (genres.lv1 * 16 + genres.lv2).toString(16) + ", " + (genres.un1 * 16 + genres.un2).toString(16);
            }
        }
    } else {
      // BS/地デジ
      strGenre = GENRE_LV1[genres.lv1] + "(" + GENRE_LV2[genres.lv1 * 16 + genres.lv2] + ")";
    }
    return strGenre;
}

function escapeXMLSpecialChars(str: string): string {
    return str.replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function getDateTime(time: number): string {
    return new Date(time).toISOString()
        .replace(/\..+$/, "")
        .replace(/[-:T]/g, "");
}

export const get: Operation = async (req, res) => {

    const apiRoot = `${req.protocol}://${req.headers.host}/api`;

    const services = [..._.service.items]; // shallow copy
    services.sort((a, b) => a.getOrder() - b.getOrder());

    let x = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    x += `<!DOCTYPE tv SYSTEM "xmltv.dtd">\n`;
    x += `<tv source-info-name="Mirakurun">\n`;

    const countMap = new Map<number, number>();
    for (const service of services) {
        if (service.type !== 1) {
            continue;
        }

        const mainNum = service.remoteControlKeyId || service.serviceId;
        if (countMap.has(mainNum)) {
            countMap.set(mainNum, countMap.get(mainNum) + 1);
        } else {
            countMap.set(mainNum, 1);
        }
        const subNum = countMap.get(mainNum);

        x += `<channel id="${service.id}">\n`;
        x += `<display-name>${escapeXMLSpecialChars(service.name)}</display-name>\n`;
        x += `<display-name>${mainNum}.${subNum}</display-name>\n`;
        if (await Service.isLogoDataExists(service.networkId, service.logoId)) {
            x += `<icon src="${apiRoot}/services/${service.id}/logo" />`;
        }
        x += `</channel>\n`;
    }

    for (const program of _.program.itemMap.values()) {
        const service = _.service.get(program.networkId, program.serviceId);
        if (service === null) {
            continue;
        }
        x += `<programme start="${getDateTime(program.startAt)}" stop="${getDateTime(program.startAt + program.duration)}" channel="${service.id}">\n`;
        x += `<title>${escapeXMLSpecialChars(program.name || "")}</title>\n`;
        x += `<desc>${escapeXMLSpecialChars(program.description || "")}</desc>\n`;
        if ( "genres" in program ) {
            x += `<category>${getGenreStrings(program.genres[0])}</category>`;
        }
        x += `</programme>\n`;
    }

    x += `</tv>`;

    res.setHeader("Content-Type", "text/xml; charset=utf-8");
    res.status(200);
    res.end(x);
};

get.apiDoc = {
    tags: ["iptv"],
    summary: "IPTV - XMLTV EPG Data",
    produces: ["text/xml"],
    responses: {
        200: {
            description: "OK"
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};
