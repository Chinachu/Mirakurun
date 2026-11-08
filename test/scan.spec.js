const { describe, it, before, after } = require("node:test");
const assert = require("assert");

const _ = require("../lib/Mirakurun/_").default;
const scan = require("../lib/Mirakurun/api/config/channels/scan");

const range = (start, end, f) => Array.from({ length: end - start + 1 }, (_, i) => f(i + start));

describe("[scan.spec] /api/config/channel/scan : generateScanConfig", () => {
    it("type of 4.3.0: the channels of the type by the parameters of 4.3.0", () => {
        const bs = range(1, 23, ch => [0, 1, 2, 3].map(subCh => `BS${String(ch).padStart(2, "0")}_${subCh}`)).flat();
        assert.deepStrictEqual(scan.generateLegacyScanConfig({ type: "GR" }), { channels: range(13, 62, ch => `${ch}`) });
        assert.deepStrictEqual(scan.generateLegacyScanConfig({ type: "BS" }), { channels: bs });
        assert.deepStrictEqual(scan.generateLegacyScanConfig({ type: "BS", useSubCh: false }), { channels: range(101, 256, ch => `${ch}`) });
        assert.deepStrictEqual(scan.generateLegacyScanConfig({ type: "CS", startCh: 2, endCh: 3, scanMode: "Channel" }), { channels: ["CS2", "CS3"], scanMode: "Channel" });
        assert.deepStrictEqual(scan.generateLegacyScanConfig({ type: "GR", channelNameFormat: "C{ch}", startCh: 13, endCh: 14 }), { channels: ["C13", "C14"] });
        // the subchannels only for BS of the subchannel style
        assert.deepStrictEqual(scan.generateLegacyScanConfig({ type: "CS", channelNameFormat: "CS{ch}_{subch}", startCh: 2, endCh: 2, startSubCh: 1, endSubCh: 2 }), { channels: ["CS2_0"] });
        assert.strictEqual(scan.generateLegacyScanConfig({ type: "SKY" }), undefined);

        assert.deepStrictEqual(scan.getLegacySkipChannels(["13", "14", "BS01_0", "CS4", "C15"], ["14", "10", "C15"]), ["14", "BS01_0", "C15"]);
    });

    it("preset: the channels of each route", () => {
        const terrestrial = range(13, 62, ch => `${ch}`);
        const bs = range(1, 23, ch => [0, 1, 2, 3].map(subCh => `BS${String(ch).padStart(2, "0")}_${subCh}`)).flat();
        const cs = range(2, 24, ch => `CS${ch}`);

        assert.deepStrictEqual(scan.generateScanConfig({ route: "TER" }), { channels: terrestrial });
        assert.deepStrictEqual(scan.generateScanConfig({ route: "SAT", source: "preset" }), { channels: [...bs, ...cs] });
        assert.deepStrictEqual(scan.generateScanConfig({ route: "CATV" }), { channels: [...range(1, 12, ch => `${ch}`), ...range(13, 63, ch => `C${ch}`), ...terrestrial] });
        assert.deepStrictEqual(scan.generateScanConfig({ route: "FTTH" }), { channels: [...terrestrial, ...bs, ...cs] });
    });

    it("dvbConf: the channels of the channel config files", () => {
        assert.deepStrictEqual(scan.generateScanConfig({ route: "CATV", source: "dvbConf", dvbChannels: ["CATV_C21", "CATV_C22", "CATV_C21"] }), { channels: ["CATV_C21", "CATV_C22"] });
        assert.strictEqual(scan.generateScanConfig({ route: "CATV", source: "dvbConf", dvbChannels: [] }), undefined);
    });

    it("list: the channels listed (trimmed, without the empty and the duplicated)", () => {
        assert.deepStrictEqual(scan.generateScanConfig({ route: "CATV", source: "list", channels: [" C13", "27", "", "C13"] }), { channels: ["C13", "27"] });
        assert.strictEqual(scan.generateScanConfig({ route: "CATV", source: "list", channels: [] }), undefined);
    });

    it("format: the channels of the format in the ranges", () => {
        assert.deepStrictEqual(scan.generateScanConfig({ route: "CATV", source: "format", channelNameFormat: "C{ch}", startCh: 13, endCh: 15 }), { channels: ["C13", "C14", "C15"] });
        assert.deepStrictEqual(
            scan.generateScanConfig({ route: "SAT", source: "format", channelNameFormat: "BS{ch00}_{subch}", startCh: 1, endCh: 1, startSubCh: 1, endSubCh: 2 }),
            { channels: ["BS01_1", "BS01_2"] }
        );
        assert.strictEqual(scan.generateScanConfig({ route: "CATV", source: "format", startCh: 13, endCh: 15 }), undefined);
        assert.strictEqual(scan.generateScanConfig({ route: "CATV", source: "format", channelNameFormat: "C{ch}" }), undefined);
    });

    it("scanMode and setDisabledOnAdd are by the type of each stream unless specified", () => {
        assert.deepStrictEqual(scan.generateScanConfig({ route: "TER", scanMode: "Service", setDisabledOnAdd: false }), {
            channels: range(13, 62, ch => `${ch}`),
            scanMode: "Service",
            setDisabledOnAdd: false
        });
    });

    it("rejects an unknown route or source", () => {
        assert.strictEqual(scan.generateScanConfig({ route: "XXX" }), undefined);
        assert.strictEqual(scan.generateScanConfig({ route: "TER", source: "xxx" }), undefined);
    });
});

describe("[scan.spec] /api/config/channel/scan : getChannelTypeByNetwork", () => {
    it("decides the type by the network", () => {
        assert.strictEqual(scan.getChannelTypeByNetwork(4, "ts"), "BS");
        assert.strictEqual(scan.getChannelTypeByNetwork(6, "ts"), "CS");
        assert.strictEqual(scan.getChannelTypeByNetwork(7, "ts"), "CS");
        assert.strictEqual(scan.getChannelTypeByNetwork(10, "ts"), "SKY");
        assert.strictEqual(scan.getChannelTypeByNetwork(0x7FE0, "ts"), "GR");
        assert.strictEqual(scan.getChannelTypeByNetwork(0x7880, "ts"), "GR");
        // the services of the cable television itself
        assert.strictEqual(scan.getChannelTypeByNetwork(0xFFFE, "ts"), "GR");
        assert.strictEqual(scan.getChannelTypeByNetwork(11, "tlv"), "BS4K");
        assert.strictEqual(scan.getChannelTypeByNetwork(0x1234, "ts"), null);
    });
});

describe("[scan.spec] /api/config/channel/scan : generateScannedChannelItems", () => {
    let tuner;
    before(() => {
        tuner = _.tuner;
        _.tuner = { typeExists: (type, route) => ["GR", "BS", "CS", "BS4K"].includes(type) };
    });
    after(() => {
        _.tuner = tuner;
    });

    const service = (networkId, serviceId, name, type = 1) => ({ networkId, serviceId, name, type, streamId: 1 });

    it("adds the entries of each type of the streams of a CATV channel", () => {
        const logs = [];
        const items = scan.generateScannedChannelItems("C21", "CATV", [
            { relTs: 1, format: "ts", services: [service(4, 101, "BS 1"), service(4, 102, "BS 2")] },
            { relTs: 2, format: "ts", services: [service(0xFFFE, 1, "コミュニティ", 0xA4), service(0xFFFE, 2, "コミュニティ")] },
            { relTs: 3, format: "tlv", services: [service(11, 101, "4K")] },
            { relTs: 4, format: "ts", services: [service(0x1234, 1, "unknown")] }
        ], {}, text => logs.push(text));

        assert.deepStrictEqual(items, [
            { name: "BS 1", type: "BS", channel: "C21", serviceId: 101, isDisabled: true, route: "CATV", tsmfRelTs: 1 },
            { name: "BS 2", type: "BS", channel: "C21", serviceId: 102, isDisabled: true, route: "CATV", tsmfRelTs: 1 },
            { name: "コミュニティ", type: "GR", channel: "C21", isDisabled: false, route: "CATV", tsmfRelTs: 2 },
            { name: "4K", type: "BS4K", channel: "C21", serviceId: 101, isDisabled: true, route: "CATV", tsmfRelTs: 3 }
        ]);
        assert.ok(logs.some(text => /unknown network/.test(text)));
    });

    it("does not specify the relative stream if the type has more than one on the channel", () => {
        const logs = [];
        const items = scan.generateScannedChannelItems("C22", "CATV", [
            { relTs: 1, format: "ts", services: [service(4, 101, "BS 1")] },
            { relTs: 2, format: "ts", services: [service(4, 103, "BS 3")] }
        ], {}, text => logs.push(text));

        assert.deepStrictEqual(items.map(item => [item.type, item.serviceId, item.tsmfRelTs]), [["BS", 101, undefined], ["BS", 103, undefined]]);
        assert.ok(logs.some(text => /relative streams of BS are detected/.test(text)));
    });

    // スキャンに失敗した相対 TS も TSMF のヘッダーのネットワークで数え、ほかの相対 TS を指定しない
    it("does not specify the relative stream if another one of the type has failed to scan", () => {
        const logs = [];
        const items = scan.generateScannedChannelItems("C23", "CATV", [
            { relTs: 1, format: "ts", networkId: 4, services: [service(4, 101, "BS 1")] },
            { relTs: 2, format: "ts", networkId: 4, services: [], failed: true },
            { relTs: 3, format: "ts", networkId: 0xFFFE, services: [], failed: true },
            { relTs: 9, format: "ts", networkId: 4, services: [] }
        ], {}, text => logs.push(text));

        assert.deepStrictEqual(items.map(item => [item.type, item.serviceId, item.tsmfRelTs]), [["BS", 101, undefined]]);
        assert.ok(logs.some(text => /relative stream 2 \(BS\) are not received/.test(text)));
        assert.ok(logs.some(text => /relative stream 3 \(GR\) are not received/.test(text)));
    });

    it("adds the carriers of a TLV of multiple carriers without the services", () => {
        const items = scan.generateScannedChannelItems("C30", "CATV", [
            { relTs: 1, format: "tlv", services: [], numberOfCarriers: 3 }
        ], {});

        assert.deepStrictEqual(items, [{ name: "BS4KC30", type: "BS4K", channel: "C30", isDisabled: true, route: "CATV" }]);
    });

    it("does not add the route of the default of the type, nor the relative stream of a stream without TSMF", () => {
        assert.deepStrictEqual(
            scan.generateScannedChannelItems("27", "TER", [{ format: "ts", services: [service(0x7FE0, 1024, "地上 1"), service(0x7FE0, 1025, "地上 2")] }], {}),
            [{ name: "地上", type: "GR", channel: "27", isDisabled: false }]
        );
        assert.deepStrictEqual(
            scan.generateScannedChannelItems("BS01_0", "SAT", [{ format: "ts", services: [service(4, 101, "BS 1")] }], { scanMode: "Channel", setDisabledOnAdd: false }),
            [{ name: "BS 1", type: "BS", channel: "BS01_0", isDisabled: false }]
        );
    });

    // リモートの Mirakurun は、その Mirakurun に設定されたタイプのチャンネルだけを受信する
    it("adds the channel received by the remote tuner as the type received", () => {
        const logs = [];
        const items = scan.generateScannedChannelItems("C25", "CATV", [
            { format: "ts", services: [service(4, 101, "BS 1")] }
        ], {}, text => logs.push(text), "GR");

        assert.deepStrictEqual(items.map(item => [item.type, item.channel, item.route]), [["GR", "C25", "CATV"]]);
        assert.ok(logs.some(text => /received by the remote tuner as GR \(the network is of BS\)/.test(text)));
    });

    // リモートの Mirakurun は判別した相対 TS を出力するため、リモートのチューナーで受信したチャンネルには tsmfRelTs を書かない
    it("does not specify the relative stream for the channel received by the remote tuner", () => {
        const items = scan.generateScannedChannelItems("C19", "CATV", [
            { relTs: 1, format: "tlv", networkId: 11, services: [service(11, 101, "4K")] }
        ], {}, () => undefined, "BS4K");
        assert.deepStrictEqual(items, [{ name: "4K", type: "BS4K", channel: "C19", serviceId: 101, isDisabled: true, route: "CATV" }]);

        // scanned by the local tuners, the type received only by the remote tuners outputting the relative streams
        const mixed = scan.generateScannedChannelItems("C19", "CATV", [
            { relTs: 1, format: "ts", networkId: 0xFFFE, services: [service(0xFFFE, 1, "コミュニティ")] },
            { relTs: 2, format: "tlv", networkId: 11, services: [service(11, 101, "4K")] }
        ], {}, () => undefined, undefined, ["BS4K"]);
        assert.deepStrictEqual(mixed.map(item => [item.type, item.tsmfRelTs]), [["GR", 1], ["BS4K", undefined]]);
    });

    it("notes the types without the tuners of the route", () => {
        const logs = [];
        scan.generateScannedChannelItems("C23", "CATV", [{ relTs: 1, format: "ts", services: [service(10, 1, "SKY")] }], {}, text => logs.push(text));
        assert.ok(logs.some(text => /no tuners of SKY/.test(text)));
    });
});

describe("[scan.spec] /api/config/channel/scan : generateChannelItemForService", () => {
    it("GR Regular case", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const service = {
            name: "XXXテレビ",
            serviceId: 1
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: service.name,
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });

    it("BS Regular case", () => {
        const type = "BS";
        const ch = "20";
        const setDisabledOnAdd = false;
        const service = {
            name: "XXXテレビ",
            serviceId: 10
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: service.name,
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });

    it("BS Regular case (Subchannel style)", () => {
        const type = "BS";
        const ch = "BS01_1";
        const setDisabledOnAdd = false;
        const service = {
            name: "XXXテレビ",
            serviceId: 10
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: service.name,
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });

    it("CS Regular case", () => {
        const type = "CS";
        const ch = "CS30";
        const setDisabledOnAdd = false;
        const service = {
            name: "XXXテレビ",
            serviceId: 999
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: service.name,
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });

    it("Name trim : half-width whitespace (end)", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const service = {
            name: "X　X テレビ ",
            serviceId: 1
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });

    it("Name trim : half-width whitespace (start)", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const service = {
            name: " X　X テレビ",
            serviceId: 1
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });

    it("Name trim : half-width whitespace (start and end)", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const service = {
            name: " X　X テレビ ",
            serviceId: 1
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });

    it("Name trim : full-width whitespace (end)", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const service = {
            name: "X　X テレビ　",
            serviceId: 1
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });

    it("Name trim : full-width whitespace (start)", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const service = {
            name: "　X　X テレビ",
            serviceId: 1
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });

    it("Name trim : full-width whitespace (start and end)", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const service = {
            name: "　X　X テレビ　",
            serviceId: 1
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });

    it("Name trim : multiple whitespace (start and end) case.1", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const service = {
            name: " 　X　X テレビ　 ",
            serviceId: 1
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });

    it("Name trim : multiple whitespace (start and end) case.2", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const service = {
            name: "　 X　X テレビ 　",
            serviceId: 1
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });

    it("Name Empty", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const service = {
            name: "",
            serviceId: 1
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "GR10:1",
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });

    it("Name Empty trim case", () => {
        const type = "GR";
        const ch = "999";
        const setDisabledOnAdd = true;
        const service = {
            name: " 　",
            serviceId: 10
        };
        const channelItem = scan.generateChannelItemForService(type, ch, service, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "GR999:10",
            type: type,
            channel: ch,
            serviceId: service.serviceId,
            isDisabled: setDisabledOnAdd
        });
    });
});

describe("[scan.spec] /api/config/channel/scan : generateChannelItemForChannel (single service)", () => {
    it("GR Regular case", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "XXXテレビ" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: services[0].name,
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("BS Regular case", () => {
        const type = "BS";
        const ch = "20";
        const setDisabledOnAdd = false;
        const services = [
            { name: "XXXテレビ" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: services[0].name,
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("BS Regular case (Subchannel style)", () => {
        const type = "BS";
        const ch = "BS01_1";
        const setDisabledOnAdd = false;
        const services = [
            { name: "XXXテレビ" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: services[0].name,
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("CS Regular case", () => {
        const type = "CS";
        const ch = "CS30";
        const setDisabledOnAdd = false;
        const services = [
            { name: "XXXテレビ" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: services[0].name,
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name trim : half-width whitespace (end)", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "X　X テレビ " }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name trim : half-width whitespace (start)", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: " X　X テレビ" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name trim : half-width whitespace (start and end)", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: " X　X テレビ " }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name trim : full-width whitespace (end)", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "X　X テレビ　" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name trim : full-width whitespace (start)", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "　X　X テレビ" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name trim : full-width whitespace (start and end)", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "　X　X テレビ　" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name trim : multiple whitespace (start and end) case.1", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: " 　X　X テレビ　 " }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name trim : multiple whitespace (start and end) case.2", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "　 X　X テレビ 　" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "X　X テレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Empty", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "GR10",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Empty trim case", () => {
        const type = "GR";
        const ch = "999";
        const setDisabledOnAdd = true;
        const services = [
            { name: " 　" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "GR999",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });
});

describe("[scan.spec] /api/config/channel/scan : generateChannelItemForChannel (multiple service)", () => {
    it("Name Summary regular case.1", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "xxxテレビ１" },
            { name: "xxxテレビ２" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "xxxテレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary regular case.2", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "xxxテレビ" },
            { name: "xxxテレビ１" },
            { name: "xxxテレビ２" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "xxxテレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary regular case.3", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "xxxテレビ" },
            { name: "xxxテレビ１" },
            { name: "データ通信" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "xxxテレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary regular case.4", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "xxxテレビ" },
            { name: "xxxテレビ" },
            { name: "xxxテレビ" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "xxxテレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary regular case.5", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "xxxテレビ総合" },
            { name: "xxxテレビ" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "xxxテレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary regular case.6", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "aaaテレビ" },
            { name: "bbbテレビ" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "aaaテレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary and trim.1", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: " xxxテレビ " },
            { name: " xxxテレビ " }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "xxxテレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary and trim.2", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: " xxxテレビ " },
            { name: " xxxテレビ" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "xxxテレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary and trim.3", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: " xxxテレビ " },
            { name: " xxxTV" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "xxx",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary and trim.4", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: " xxxテレビ " },
            { name: " aaaテレビ " }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "GR10",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary and trim.5", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: " xxxテレビ " },
            { name: "xxxTV " }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "xxxテレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary and trim.6", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "xxxテレビ " },
            { name: "xxxテレビ １" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "xxxテレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary and trim.7", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "xxxテレビ １" },
            { name: "xxxテレビ " }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "xxxテレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Full text match case.1", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "abcdefg" },
            { name: "abcdefg" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "abcdefg",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Full text match case.2", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "abcdefg" },
            { name: "abcdefgf" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "abcdefg",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Full text match case.3", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "abcdefg" },
            { name: "xxxxx" },
            { name: "abcdefg" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "abcdefg",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Full text match case.4", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "abcdefg" },
            { name: "xxxxx" },
            { name: "abcdefg" },
            { name: "xxx" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "abcdefg",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Partial text match case.1", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "abcdefg" },
            { name: "abcabc" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "abc",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Partial text match case.2", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "abcdefg" },
            { name: "xxxx" },
            { name: "abcabc" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "abc",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Partial text match case.3", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "abcdefg" },
            { name: "xxxx" },
            { name: "abcabc" },
            { name: "yyy" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "abc",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Not match case.1", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "abcdefg" },
            { name: "xxxx" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "abcdefg",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Not match case.2", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "abcdefg" },
            { name: "xabcdefg" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "abcdefg",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Not match case.3", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "abcdefg" },
            { name: "yyy" },
            { name: "xxx" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "abcdefg",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Not match case.4", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "abcdefg" },
            { name: "" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "abcdefg",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Not match case.5", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "abcdefg" },
            { name: " " }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "abcdefg",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Empty case.1", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "" },
            { name: "abcdefg" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "GR10",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Empty case.2", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "" },
            { name: "" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "GR10",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Empty case.3", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "" },
            { name: " " }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "GR10",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Empty case.4", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: " " },
            { name: "abcdefg" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "GR10",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Empty case.5", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: " " },
            { name: "" }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "GR10",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });

    it("Name Summary : Empty case.6", () => {
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: " " },
            { name: " " }
        ];
        const channelItem = scan.generateChannelItemForChannel(type, ch, services, setDisabledOnAdd);
        assert.deepStrictEqual(channelItem, {
            name: "GR10",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItem, false);
    });
});

describe("[scan.spec] /api/config/channel/scan : generateChannelItems", () => {
    it("Service mode case.1", () => {
        const mode = "Service";
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "XXXテレビ", serviceId: 1 }
        ];
        const channelItems = scan.generateChannelItems(mode, type, ch, services, setDisabledOnAdd);
        assert.strictEqual(channelItems.length, services.length);
        for (let i = 0; i < channelItems.length; i++) {
            assert.deepStrictEqual(channelItems[i], {
                name: services[i].name,
                type: type,
                channel: ch,
                serviceId: services[i].serviceId,
                isDisabled: setDisabledOnAdd
            });
        }
    });

    it("Service mode case.2 : multiple service", () => {
        const mode = "Service";
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "XXXテレビ１", serviceId: 101 },
            { name: "XXXテレビ２", serviceId: 102 }
        ];
        const channelItems = scan.generateChannelItems(mode, type, ch, services, setDisabledOnAdd);
        assert.strictEqual(channelItems.length, services.length);
        for (let i = 0; i < channelItems.length; i++) {
            assert.deepStrictEqual(channelItems[i], {
                name: services[i].name,
                type: type,
                channel: ch,
                serviceId: services[i].serviceId,
                isDisabled: setDisabledOnAdd
            });
        }
    });

    it("Channel mode case.1", () => {
        const mode = "Channel";
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "XXXテレビ", serviceId: 1 }
        ];
        const channelItems = scan.generateChannelItems(mode, type, ch, services, setDisabledOnAdd);
        assert.strictEqual(channelItems.length, 1);
        assert.deepStrictEqual(channelItems[0], {
            name: services[0].name,
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItems[0], false);
    });

    it("Channel mode case.2 : multiple service", () => {
        const mode = "Channel";
        const type = "GR";
        const ch = "10";
        const setDisabledOnAdd = true;
        const services = [
            { name: "XXXテレビ１", serviceId: 101 },
            { name: "XXXテレビ２", serviceId: 102 }
        ];
        const channelItems = scan.generateChannelItems(mode, type, ch, services, setDisabledOnAdd);
        assert.strictEqual(channelItems.length, 1);
        assert.deepStrictEqual(channelItems[0], {
            name: "XXXテレビ",
            type: type,
            channel: ch,
            isDisabled: setDisabledOnAdd
        });
        assert.strictEqual("serviceId" in channelItems[0], false);
    });
});
