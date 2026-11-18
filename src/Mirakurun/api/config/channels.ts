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
import { Operation } from "express-openapi";
import * as api from "../../api";
import * as apid from "../../../../api";
import * as config from "../../config";

export const get: Operation = async (req, res) => {
    res.status(200);
    const channels = await config.loadChannels() as apid.ConfigChannels;
    // 旧YAMLの0・null・空文字は未指定として返し、GETの本文を編集したPUTでも再保存できるようにする。
    // 読み込みだけで元の設定ファイルや共有オブジェクトを書き換えない。
    // 範囲外の値は未指定へ変換せず、設定画面で該当行を修正できるよう元の値を返す。
    api.responseJSON(res, channels.map(channel => {
        const relTs: unknown = channel.tsmfRelTs;
        return relTs === 0 || relTs === null || relTs === "" ? { ...channel, tsmfRelTs: undefined } : channel;
    }));
};

get.apiDoc = {
    tags: ["config"],
    operationId: "getChannelsConfig",
    // PUTと共通のスキーマは保存可能な値を示す。設定修正用GETの範囲外値は以下の例外として明記する。
    description: "保存済みのチャンネル設定を返します。設定ファイルを修正できるよう、範囲外のtsmfRelTs（16など）も値を補正せず返します。ただし、旧形式の0・null・空文字は未指定として省略します。スキーマの1〜15は保存時の制約です。PUT前に範囲外の値を修正するか、その項目を削除してください。",
    responses: {
        200: {
            description: "OK",
            schema: {
                $ref: "#/definitions/ConfigChannels"
            }
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};

export const put: Operation = async (req, res) => {
    const channels: apid.ConfigChannels = req.body;
    if (!Array.isArray(channels)) {
        api.responseError(res, 400, "チャンネル設定の本文には配列を指定してください。");
        return;
    }
    // 設定全体の置換なので既存の不正な行も検証する。値の削除・補正で受信入力を変えず、行番号を返して修正を求める。
    const invalidRelTs = channels.findIndex(channel => channel?.tsmfRelTs !== undefined
        && (!Number.isInteger(channel.tsmfRelTs) || channel.tsmfRelTs < 1 || channel.tsmfRelTs > 15));
    if (invalidRelTs !== -1) {
        api.responseError(res, 400, `チャンネル設定の${invalidRelTs + 1}行目のtsmfRelTsは1〜15の整数で指定してください。`);
        return;
    }

    await config.saveChannels(channels);

    res.status(200);
    api.responseJSON(res, channels);
};

put.apiDoc = {
    tags: ["config"],
    operationId: "updateChannelsConfig",
    parameters: [
        {
            in: "body",
            name: "body",
            schema: {
                $ref: "#/definitions/ConfigChannels"
            }
        }
    ],
    responses: {
        200: {
            description: "OK",
            schema: {
                $ref: "#/definitions/ConfigChannels"
            }
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};
