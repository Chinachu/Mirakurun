var assert = require('assert');

const scan = require("../lib/Mirakurun/api/config/channels/scan");

describe("Mirakurun/api/config/channel/scan : generateScanConfig", () => {

    it("GR: Type only", () => {
        const config = scan.generateScanConfig({
            type: "GR"
        });
        assert.deepStrictEqual(config, {
            channels: ["13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62"],
            scanMode: "Channel",
            setDisabledOnAdd: false
        });
    });

    it("GR: startCh only", () => {
        const config = scan.generateScanConfig({
            type: "GR",
            startCh: 61
        });
        assert.deepStrictEqual(config, {
            channels: ["61", "62"],
            scanMode: "Channel",
            setDisabledOnAdd: false
        });
    });

    it("GR: endCh only", () => {
        const config = scan.generateScanConfig({
            type: "GR",
            endCh: 14
        });
        assert.deepStrictEqual(config, {
            channels: ["13", "14"],
            scanMode: "Channel",
            setDisabledOnAdd: false
        });
    });

    it("GR: startCh and endCh", () => {
        const config = scan.generateScanConfig({
            type: "GR",
            startCh: 10,
            endCh: 15
        });
        assert.deepStrictEqual(config, {
            channels: ["10", "11", "12", "13", "14", "15"],
            scanMode: "Channel",
            setDisabledOnAdd: false
        });
    });

    it("GR: subCh is not use", () => {
        const config = scan.generateScanConfig({
            type: "GR",
            startSubCh: 5,
            endSubCh: 10
        });
        assert.deepStrictEqual(config, {
            channels: ["13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62"],
            scanMode: "Channel",
            setDisabledOnAdd: false
        });
    });

    it("GR: useSubCh = false", () => {
        const config = scan.generateScanConfig({
            type: "GR",
            useSubCh: false
        });
        assert.deepStrictEqual(config, {
            channels: ["13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62"],
            scanMode: "Channel",
            setDisabledOnAdd: false
        });
    });

    it("GR: useSubCh = false and subCh", () => {
        const config = scan.generateScanConfig({
            type: "GR",
            useSubCh: false,
            startSubCh: 5,
            endSubCh: 10
        });
        assert.deepStrictEqual(config, {
            channels: ["13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62"],
            scanMode: "Channel",
            setDisabledOnAdd: false
        });
    });

    it("GR: useSubCh = true", () => {
        const config = scan.generateScanConfig({
            type: "GR",
            useSubCh: true
        });
        assert.deepStrictEqual(config, {
            channels: ["13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62"],
            scanMode: "Channel",
            setDisabledOnAdd: false
        });
    });

    it("GR: useSubCh = true and subCh", () => {
        const config = scan.generateScanConfig({
            type: "GR",
            useSubCh: true,
            startSubCh: 5,
            endSubCh: 10
        });
        assert.deepStrictEqual(config, {
            channels: ["13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62"],
            scanMode: "Channel",
            setDisabledOnAdd: false
        });
    });

    it("GR: scanMode = Channel", () => {
        const config = scan.generateScanConfig({
            type: "GR",
            scanMode: "Channel"
        });
        assert.deepStrictEqual(config, {
            channels: ["13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62"],
            scanMode: "Channel",
            setDisabledOnAdd: false
        });
    });

    it("GR: scanMode = Service", () => {
        const config = scan.generateScanConfig({
            type: "GR",
            scanMode: "Service"
        });
        assert.deepStrictEqual(config, {
            channels: ["13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62"],
            scanMode: "Service",
            setDisabledOnAdd: false
        });
    });

    it("GR: setDisabledOnAdd = true", () => {
        const config = scan.generateScanConfig({
            type: "GR",
            setDisabledOnAdd: true
        });
        assert.deepStrictEqual(config, {
            channels: ["13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62"],
            scanMode: "Channel",
            setDisabledOnAdd: true
        });
    });

    it("GR: setDisabledOnAdd = false", () => {
        const config = scan.generateScanConfig({
            type: "GR",
            setDisabledOnAdd: false
        });
        assert.deepStrictEqual(config, {
            channels: ["13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62"],
            scanMode: "Channel",
            setDisabledOnAdd: false
        });
    });

    it("BS: Type only", () => {
        const config = scan.generateScanConfig({
            type: "BS"
        });
        assert.deepStrictEqual(config, {
            channels: ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "111", "112", "113", "114", "115", "116", "117", "118", "119", "120", "121", "122", "123", "124", "125", "126", "127", "128", "129", "130", "131", "132", "133", "134", "135", "136", "137", "138", "139", "140", "141", "142", "143", "144", "145", "146", "147", "148", "149", "150", "151", "152", "153", "154", "155", "156", "157", "158", "159", "160", "161", "162", "163", "164", "165", "166", "167", "168", "169", "170", "171", "172", "173", "174", "175", "176", "177", "178", "179", "180", "181", "182", "183", "184", "185", "186", "187", "188", "189", "190", "191", "192", "193", "194", "195", "196", "197", "198", "199", "200", "201", "202", "203", "204", "205", "206", "207", "208", "209", "210", "211", "212", "213", "214", "215", "216", "217", "218", "219", "220", "221", "222", "223", "224", "225", "226", "227", "228", "229", "230", "231", "232", "233", "234", "235", "236", "237", "238", "239", "240", "241", "242", "243", "244", "245", "246", "247", "248", "249", "250", "251", "252", "253", "254", "255", "256"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("BS: startCh only", () => {
        const config = scan.generateScanConfig({
            type: "BS",
            startCh: 255
        });
        assert.deepStrictEqual(config, {
            channels: ["255", "256"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("BS: endCh only", () => {
        const config = scan.generateScanConfig({
            type: "BS",
            endCh: 102
        });
        assert.deepStrictEqual(config, {
            channels: ["101", "102"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("BS: startCh and endCh", () => {
        const config = scan.generateScanConfig({
            type: "BS",
            startCh: 10,
            endCh: 15
        });
        assert.deepStrictEqual(config, {
            channels: ["10", "11", "12", "13", "14", "15"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("BS: subCh is not use", () => {
        const config = scan.generateScanConfig({
            type: "BS",
            startSubCh: 5,
            endSubCh: 10
        });
        assert.deepStrictEqual(config, {
            channels: ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "111", "112", "113", "114", "115", "116", "117", "118", "119", "120", "121", "122", "123", "124", "125", "126", "127", "128", "129", "130", "131", "132", "133", "134", "135", "136", "137", "138", "139", "140", "141", "142", "143", "144", "145", "146", "147", "148", "149", "150", "151", "152", "153", "154", "155", "156", "157", "158", "159", "160", "161", "162", "163", "164", "165", "166", "167", "168", "169", "170", "171", "172", "173", "174", "175", "176", "177", "178", "179", "180", "181", "182", "183", "184", "185", "186", "187", "188", "189", "190", "191", "192", "193", "194", "195", "196", "197", "198", "199", "200", "201", "202", "203", "204", "205", "206", "207", "208", "209", "210", "211", "212", "213", "214", "215", "216", "217", "218", "219", "220", "221", "222", "223", "224", "225", "226", "227", "228", "229", "230", "231", "232", "233", "234", "235", "236", "237", "238", "239", "240", "241", "242", "243", "244", "245", "246", "247", "248", "249", "250", "251", "252", "253", "254", "255", "256"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("BS: useSubCh = false", () => {
        const config = scan.generateScanConfig({
            type: "BS",
            useSubCh: false
        });
        assert.deepStrictEqual(config, {
            channels: ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "111", "112", "113", "114", "115", "116", "117", "118", "119", "120", "121", "122", "123", "124", "125", "126", "127", "128", "129", "130", "131", "132", "133", "134", "135", "136", "137", "138", "139", "140", "141", "142", "143", "144", "145", "146", "147", "148", "149", "150", "151", "152", "153", "154", "155", "156", "157", "158", "159", "160", "161", "162", "163", "164", "165", "166", "167", "168", "169", "170", "171", "172", "173", "174", "175", "176", "177", "178", "179", "180", "181", "182", "183", "184", "185", "186", "187", "188", "189", "190", "191", "192", "193", "194", "195", "196", "197", "198", "199", "200", "201", "202", "203", "204", "205", "206", "207", "208", "209", "210", "211", "212", "213", "214", "215", "216", "217", "218", "219", "220", "221", "222", "223", "224", "225", "226", "227", "228", "229", "230", "231", "232", "233", "234", "235", "236", "237", "238", "239", "240", "241", "242", "243", "244", "245", "246", "247", "248", "249", "250", "251", "252", "253", "254", "255", "256"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("BS: useSubCh = false and subCh", () => {
        const config = scan.generateScanConfig({
            type: "BS",
            useSubCh: false,
            startSubCh: 5,
            endSubCh: 10
        });
        assert.deepStrictEqual(config, {
            channels: ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "111", "112", "113", "114", "115", "116", "117", "118", "119", "120", "121", "122", "123", "124", "125", "126", "127", "128", "129", "130", "131", "132", "133", "134", "135", "136", "137", "138", "139", "140", "141", "142", "143", "144", "145", "146", "147", "148", "149", "150", "151", "152", "153", "154", "155", "156", "157", "158", "159", "160", "161", "162", "163", "164", "165", "166", "167", "168", "169", "170", "171", "172", "173", "174", "175", "176", "177", "178", "179", "180", "181", "182", "183", "184", "185", "186", "187", "188", "189", "190", "191", "192", "193", "194", "195", "196", "197", "198", "199", "200", "201", "202", "203", "204", "205", "206", "207", "208", "209", "210", "211", "212", "213", "214", "215", "216", "217", "218", "219", "220", "221", "222", "223", "224", "225", "226", "227", "228", "229", "230", "231", "232", "233", "234", "235", "236", "237", "238", "239", "240", "241", "242", "243", "244", "245", "246", "247", "248", "249", "250", "251", "252", "253", "254", "255", "256"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("BS: useSubCh = true", () => {
        const config = scan.generateScanConfig({
            type: "BS",
            useSubCh: true
        });
        assert.deepStrictEqual(config, {
            channels: ["BS01_0", "BS01_1", "BS01_2", "BS01_3", "BS02_0", "BS02_1", "BS02_2", "BS02_3", "BS03_0", "BS03_1", "BS03_2", "BS03_3", "BS04_0", "BS04_1", "BS04_2", "BS04_3", "BS05_0", "BS05_1", "BS05_2", "BS05_3", "BS06_0", "BS06_1", "BS06_2", "BS06_3", "BS07_0", "BS07_1", "BS07_2", "BS07_3", "BS08_0", "BS08_1", "BS08_2", "BS08_3", "BS09_0", "BS09_1", "BS09_2", "BS09_3", "BS10_0", "BS10_1", "BS10_2", "BS10_3", "BS11_0", "BS11_1", "BS11_2", "BS11_3", "BS12_0", "BS12_1", "BS12_2", "BS12_3", "BS13_0", "BS13_1", "BS13_2", "BS13_3", "BS14_0", "BS14_1", "BS14_2", "BS14_3", "BS15_0", "BS15_1", "BS15_2", "BS15_3", "BS16_0", "BS16_1", "BS16_2", "BS16_3", "BS17_0", "BS17_1", "BS17_2", "BS17_3", "BS18_0", "BS18_1", "BS18_2", "BS18_3", "BS19_0", "BS19_1", "BS19_2", "BS19_3", "BS20_0", "BS20_1", "BS20_2", "BS20_3", "BS21_0", "BS21_1", "BS21_2", "BS21_3", "BS22_0", "BS22_1", "BS22_2", "BS22_3", "BS23_0", "BS23_1", "BS23_2", "BS23_3"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("BS: useSubCh = true and subCh", () => {
        const config = scan.generateScanConfig({
            type: "BS",
            useSubCh: true,
            startSubCh: 5,
            endSubCh: 8
        });
        assert.deepStrictEqual(config, {
            channels: ["BS01_5", "BS01_6", "BS01_7", "BS01_8", "BS02_5", "BS02_6", "BS02_7", "BS02_8", "BS03_5", "BS03_6", "BS03_7", "BS03_8", "BS04_5", "BS04_6", "BS04_7", "BS04_8","BS05_5", "BS05_6", "BS05_7", "BS05_8", "BS06_5", "BS06_6", "BS06_7", "BS06_8", "BS07_5", "BS07_6", "BS07_7", "BS07_8", "BS08_5", "BS08_6", "BS08_7", "BS08_8", "BS09_5", "BS09_6", "BS09_7", "BS09_8", "BS10_5", "BS10_6", "BS10_7", "BS10_8", "BS11_5", "BS11_6", "BS11_7", "BS11_8", "BS12_5", "BS12_6", "BS12_7", "BS12_8", "BS13_5", "BS13_6", "BS13_7", "BS13_8", "BS14_5", "BS14_6", "BS14_7", "BS14_8", "BS15_5", "BS15_6", "BS15_7", "BS15_8", "BS16_5", "BS16_6", "BS16_7", "BS16_8", "BS17_5", "BS17_6", "BS17_7", "BS17_8", "BS18_5", "BS18_6", "BS18_7", "BS18_8", "BS19_5", "BS19_6", "BS19_7", "BS19_8", "BS20_5", "BS20_6", "BS20_7", "BS20_8", "BS21_5", "BS21_6", "BS21_7", "BS21_8", "BS22_5", "BS22_6", "BS22_7", "BS22_8", "BS23_5", "BS23_6", "BS23_7", "BS23_8"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("BS: useSubCh = true and Ch and subCh", () => {
        const config = scan.generateScanConfig({
            type: "BS",
            useSubCh: true,
            startCh: 30,
            endCh: 31,
            startSubCh: 10,
            endSubCh: 11
        });
        assert.deepStrictEqual(config, {
            channels: ["BS30_10", "BS30_11", "BS31_10", "BS31_11"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("BS: scanMode = Channel", () => {
        const config = scan.generateScanConfig({
            type: "BS",
            scanMode: "Channel"
        });
        assert.deepStrictEqual(config, {
            channels: ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "111", "112", "113", "114", "115", "116", "117", "118", "119", "120", "121", "122", "123", "124", "125", "126", "127", "128", "129", "130", "131", "132", "133", "134", "135", "136", "137", "138", "139", "140", "141", "142", "143", "144", "145", "146", "147", "148", "149", "150", "151", "152", "153", "154", "155", "156", "157", "158", "159", "160", "161", "162", "163", "164", "165", "166", "167", "168", "169", "170", "171", "172", "173", "174", "175", "176", "177", "178", "179", "180", "181", "182", "183", "184", "185", "186", "187", "188", "189", "190", "191", "192", "193", "194", "195", "196", "197", "198", "199", "200", "201", "202", "203", "204", "205", "206", "207", "208", "209", "210", "211", "212", "213", "214", "215", "216", "217", "218", "219", "220", "221", "222", "223", "224", "225", "226", "227", "228", "229", "230", "231", "232", "233", "234", "235", "236", "237", "238", "239", "240", "241", "242", "243", "244", "245", "246", "247", "248", "249", "250", "251", "252", "253", "254", "255", "256"],
            scanMode: "Channel",
            setDisabledOnAdd: true
        });
    });

    it("BS: scanMode = Service", () => {
        const config = scan.generateScanConfig({
            type: "BS",
            scanMode: "Service"
        });
        assert.deepStrictEqual(config, {
            channels: ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "111", "112", "113", "114", "115", "116", "117", "118", "119", "120", "121", "122", "123", "124", "125", "126", "127", "128", "129", "130", "131", "132", "133", "134", "135", "136", "137", "138", "139", "140", "141", "142", "143", "144", "145", "146", "147", "148", "149", "150", "151", "152", "153", "154", "155", "156", "157", "158", "159", "160", "161", "162", "163", "164", "165", "166", "167", "168", "169", "170", "171", "172", "173", "174", "175", "176", "177", "178", "179", "180", "181", "182", "183", "184", "185", "186", "187", "188", "189", "190", "191", "192", "193", "194", "195", "196", "197", "198", "199", "200", "201", "202", "203", "204", "205", "206", "207", "208", "209", "210", "211", "212", "213", "214", "215", "216", "217", "218", "219", "220", "221", "222", "223", "224", "225", "226", "227", "228", "229", "230", "231", "232", "233", "234", "235", "236", "237", "238", "239", "240", "241", "242", "243", "244", "245", "246", "247", "248", "249", "250", "251", "252", "253", "254", "255", "256"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("BS: setDisabledOnAdd = true", () => {
        const config = scan.generateScanConfig({
            type: "BS",
            setDisabledOnAdd: true
        });
        assert.deepStrictEqual(config, {
            channels: ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "111", "112", "113", "114", "115", "116", "117", "118", "119", "120", "121", "122", "123", "124", "125", "126", "127", "128", "129", "130", "131", "132", "133", "134", "135", "136", "137", "138", "139", "140", "141", "142", "143", "144", "145", "146", "147", "148", "149", "150", "151", "152", "153", "154", "155", "156", "157", "158", "159", "160", "161", "162", "163", "164", "165", "166", "167", "168", "169", "170", "171", "172", "173", "174", "175", "176", "177", "178", "179", "180", "181", "182", "183", "184", "185", "186", "187", "188", "189", "190", "191", "192", "193", "194", "195", "196", "197", "198", "199", "200", "201", "202", "203", "204", "205", "206", "207", "208", "209", "210", "211", "212", "213", "214", "215", "216", "217", "218", "219", "220", "221", "222", "223", "224", "225", "226", "227", "228", "229", "230", "231", "232", "233", "234", "235", "236", "237", "238", "239", "240", "241", "242", "243", "244", "245", "246", "247", "248", "249", "250", "251", "252", "253", "254", "255", "256"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("BS: setDisabledOnAdd = false", () => {
        const config = scan.generateScanConfig({
            type: "BS",
            setDisabledOnAdd: false
        });
        assert.deepStrictEqual(config, {
            channels: ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "111", "112", "113", "114", "115", "116", "117", "118", "119", "120", "121", "122", "123", "124", "125", "126", "127", "128", "129", "130", "131", "132", "133", "134", "135", "136", "137", "138", "139", "140", "141", "142", "143", "144", "145", "146", "147", "148", "149", "150", "151", "152", "153", "154", "155", "156", "157", "158", "159", "160", "161", "162", "163", "164", "165", "166", "167", "168", "169", "170", "171", "172", "173", "174", "175", "176", "177", "178", "179", "180", "181", "182", "183", "184", "185", "186", "187", "188", "189", "190", "191", "192", "193", "194", "195", "196", "197", "198", "199", "200", "201", "202", "203", "204", "205", "206", "207", "208", "209", "210", "211", "212", "213", "214", "215", "216", "217", "218", "219", "220", "221", "222", "223", "224", "225", "226", "227", "228", "229", "230", "231", "232", "233", "234", "235", "236", "237", "238", "239", "240", "241", "242", "243", "244", "245", "246", "247", "248", "249", "250", "251", "252", "253", "254", "255", "256"],
            scanMode: "Service",
            setDisabledOnAdd: false
        });
    });

    it("CS: Type only", () => {
        const config = scan.generateScanConfig({
            type: "CS"
        });
        assert.deepStrictEqual(config, {
            channels: ["CS2", "CS3", "CS4", "CS5", "CS6", "CS7", "CS8", "CS9", "CS10", "CS11", "CS12", "CS13", "CS14", "CS15", "CS16", "CS17", "CS18", "CS19", "CS20", "CS21", "CS22", "CS23", "CS24"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("CS: startCh only", () => {
        const config = scan.generateScanConfig({
            type: "CS",
            startCh: 23
        });
        assert.deepStrictEqual(config, {
            channels: ["CS23", "CS24"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("CS: endCh only", () => {
        const config = scan.generateScanConfig({
            type: "CS",
            endCh: 3
        });
        assert.deepStrictEqual(config, {
            channels: ["CS2", "CS3"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("CS: startCh and endCh", () => {
        const config = scan.generateScanConfig({
            type: "CS",
            startCh: 10,
            endCh: 15
        });
        assert.deepStrictEqual(config, {
            channels: ["CS10", "CS11", "CS12", "CS13", "CS14", "CS15"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("CS: subCh is not use", () => {
        const config = scan.generateScanConfig({
            type: "CS",
            startSubCh: 5,
            endSubCh: 10
        });
        assert.deepStrictEqual(config, {
            channels: ["CS2", "CS3", "CS4", "CS5", "CS6", "CS7", "CS8", "CS9", "CS10", "CS11", "CS12", "CS13", "CS14", "CS15", "CS16", "CS17", "CS18", "CS19", "CS20", "CS21", "CS22", "CS23", "CS24"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("CS: useSubCh = false", () => {
        const config = scan.generateScanConfig({
            type: "CS",
            useSubCh: false
        });
        assert.deepStrictEqual(config, {
            channels: ["CS2", "CS3", "CS4", "CS5", "CS6", "CS7", "CS8", "CS9", "CS10", "CS11", "CS12", "CS13", "CS14", "CS15", "CS16", "CS17", "CS18", "CS19", "CS20", "CS21", "CS22", "CS23", "CS24"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("CS: useSubCh = false and subCh", () => {
        const config = scan.generateScanConfig({
            type: "CS",
            useSubCh: false,
            startSubCh: 5,
            endSubCh: 10
        });
        assert.deepStrictEqual(config, {
            channels: ["CS2", "CS3", "CS4", "CS5", "CS6", "CS7", "CS8", "CS9", "CS10", "CS11", "CS12", "CS13", "CS14", "CS15", "CS16", "CS17", "CS18", "CS19", "CS20", "CS21", "CS22", "CS23", "CS24"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("CS: useSubCh = true", () => {
        const config = scan.generateScanConfig({
            type: "CS",
            useSubCh: true
        });
        assert.deepStrictEqual(config, {
            channels: ["CS2", "CS3", "CS4", "CS5", "CS6", "CS7", "CS8", "CS9", "CS10", "CS11", "CS12", "CS13", "CS14", "CS15", "CS16", "CS17", "CS18", "CS19", "CS20", "CS21", "CS22", "CS23", "CS24"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("CS: useSubCh = true and subCh", () => {
        const config = scan.generateScanConfig({
            type: "CS",
            useSubCh: true,
            startSubCh: 5,
            endSubCh: 10
        });
        assert.deepStrictEqual(config, {
            channels: ["CS2", "CS3", "CS4", "CS5", "CS6", "CS7", "CS8", "CS9", "CS10", "CS11", "CS12", "CS13", "CS14", "CS15", "CS16", "CS17", "CS18", "CS19", "CS20", "CS21", "CS22", "CS23", "CS24"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("CS: scanMode = Channel", () => {
        const config = scan.generateScanConfig({
            type: "CS",
            scanMode: "Channel"
        });
        assert.deepStrictEqual(config, {
            channels: ["CS2", "CS3", "CS4", "CS5", "CS6", "CS7", "CS8", "CS9", "CS10", "CS11", "CS12", "CS13", "CS14", "CS15", "CS16", "CS17", "CS18", "CS19", "CS20", "CS21", "CS22", "CS23", "CS24"],
            scanMode: "Channel",
            setDisabledOnAdd: true
        });
    });

    it("CS: scanMode = Service", () => {
        const config = scan.generateScanConfig({
            type: "CS",
            scanMode: "Service"
        });
        assert.deepStrictEqual(config, {
            channels: ["CS2", "CS3", "CS4", "CS5", "CS6", "CS7", "CS8", "CS9", "CS10", "CS11", "CS12", "CS13", "CS14", "CS15", "CS16", "CS17", "CS18", "CS19", "CS20", "CS21", "CS22", "CS23", "CS24"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("CS: setDisabledOnAdd = true", () => {
        const config = scan.generateScanConfig({
            type: "CS",
            setDisabledOnAdd: true
        });
        assert.deepStrictEqual(config, {
            channels: ["CS2", "CS3", "CS4", "CS5", "CS6", "CS7", "CS8", "CS9", "CS10", "CS11", "CS12", "CS13", "CS14", "CS15", "CS16", "CS17", "CS18", "CS19", "CS20", "CS21", "CS22", "CS23", "CS24"],
            scanMode: "Service",
            setDisabledOnAdd: true
        });
    });

    it("CS: setDisabledOnAdd = false", () => {
        const config = scan.generateScanConfig({
            type: "CS",
            setDisabledOnAdd: false
        });
        assert.deepStrictEqual(config, {
            channels: ["CS2", "CS3", "CS4", "CS5", "CS6", "CS7", "CS8", "CS9", "CS10", "CS11", "CS12", "CS13", "CS14", "CS15", "CS16", "CS17", "CS18", "CS19", "CS20", "CS21", "CS22", "CS23", "CS24"],
            scanMode: "Service",
            setDisabledOnAdd: false
        });
    });
});

describe("Mirakurun/api/config/channel/scan : generateChannelItemForService", () => {

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

describe("Mirakurun/api/config/channel/scan : generateChannelItemForChannel (single service)", () => {

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

describe("Mirakurun/api/config/channel/scan : generateChannelItemForChannel (multiple service)", () => {

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

describe("Mirakurun/api/config/channel/scan : generateChannelItems", () => {

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
