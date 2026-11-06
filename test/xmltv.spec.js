const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Mock dependencies before requiring the module
const _ = require("../lib/Mirakurun/_").default;
const ServiceClass = require("../lib/Mirakurun/Service").default;

// The file to test
const xmltv = require("../lib/Mirakurun/api/iptv/xmltv");

class MockResponse {
    constructor() {
        this.headers = {};
        this.statusCode = 200;
        this.body = "";
    }
    setHeader(name, value) {
        this.headers[name] = value;
    }
    status(code) {
        this.statusCode = code;
    }
    end(data) {
        this.body += data;
    }
}

function loadFixture(name) {
    const jsonPath = path.join(__dirname, "data", "xmltv", "fixtures", `${name}.json`);
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

    // Add getOrder function to services
    data.services.forEach((s, i) => {
        s.getOrder = () => i + 1;
    });

    return data;
}

function loadGolden(name) {
    const xmlPath = path.join(__dirname, "data", "xmltv", "goldens", `${name}.xml`);
    return fs.readFileSync(xmlPath, "utf8").trim();
}

describe("api/iptv/xmltv", () => {
    let originalIsLogoDataExists;

    beforeEach(() => {
        _.service = {
            items: [],
            get: (networkId, serviceId) => {
                return _.service.items.find(s => s.networkId === networkId && s.serviceId === serviceId) || null;
            }
        };
        _.program = {
            itemMap: new Map()
        };

        originalIsLogoDataExists = ServiceClass.isLogoDataExists;
        ServiceClass.isLogoDataExists = async (networkId, logoId) => false;
    });

    afterEach(() => {
        ServiceClass.isLogoDataExists = originalIsLogoDataExists;
    });

    it("should generate empty XMLTV when no services or programs exist", async () => {
        const req = { protocol: "http", headers: { host: "localhost:40772" } };
        const res = new MockResponse();

        await xmltv.get(req, res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers["Content-Type"], "text/xml; charset=utf-8");
        assert.strictEqual(res.body, loadGolden("empty"));
    });

    it("should generate XMLTV with a valid service and program", async () => {
        const req = { protocol: "http", headers: { host: "localhost:40772" } };
        const res = new MockResponse();

        const data = loadFixture("valid");
        _.service.items = data.services;
        for (const prog of data.programs) {
            _.program.itemMap.set(prog.id, prog);
        }

        await xmltv.get(req, res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body, loadGolden("valid"));
    });

    it("should ignore services that are not type 1 or 173", async () => {
        const req = { protocol: "http", headers: { host: "localhost:40772" } };
        const res = new MockResponse();

        const data = loadFixture("invalid");
        _.service.items = data.services;

        await xmltv.get(req, res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body, loadGolden("empty"));
    });

    it("should include logo tags if Service.isLogoDataExists is true", async () => {
        ServiceClass.isLogoDataExists = async (networkId, logoId) => networkId === 2 && logoId === 10;

        const req = { protocol: "http", headers: { host: "localhost:40772" } };
        const res = new MockResponse();

        const data = loadFixture("logo");
        _.service.items = data.services;

        await xmltv.get(req, res);

        assert.strictEqual(res.body, loadGolden("logo"));
    });
});
