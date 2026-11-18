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
import type { ChannelRoute, ChannelType } from "../api";

/** 受信経路の表示名と並び順（サーバー・UI共用）。 */
export const channelRouteMap: Record<ChannelRoute, string> = {
    TER: "地上波",
    SAT: "BS/110度CS",
    SKY: "124/128度CS",
    CATV: "CATV",
    FTTH: "ひかり"
};

export const channelRoutes = Object.keys(channelRouteMap) as ChannelRoute[];

/** routeを省略したチャンネルの既定経路（サーバー・UI共用）。 */
export function getDefaultChannelRoute(type: ChannelType): ChannelRoute {
    return type === "GR" ? "TER" : type === "SKY" ? "SKY" : type === "CATV" ? "CATV" : "SAT";
}
