const { describe, it } = require("node:test");
const assert = require("assert");

// Import the functions to be tested
const common = require("../lib/Mirakurun/common");

describe("[command.spec] common.ts: replaceCommandTemplate()", () => {
  it("Basic replacement test", () => {
    const template = "cmd <channel>";
    const vars = { channel: "123" };
    const result = common.replaceCommandTemplate(template, vars);
    assert.strictEqual(result, "cmd 123");
  });

  it("Multiple variable replacements", () => {
    const template = "cmd <channel> --arg1 --arg2 <exampleArg1> <exampleArg2>";
    const vars = {
      channel: "123",
      exampleArg1: "-arg0 -arg1=example",
      exampleArg2: "-arg2 value"
    };
    const result = common.replaceCommandTemplate(template, vars);
    assert.strictEqual(result, "cmd 123 --arg1 --arg2 -arg0 -arg1=example -arg2 value");
  });

  it("Non-existent variables are replaced with empty strings", () => {
    const template = "cmd <channel> <nonExistentVar>";
    const vars = { channel: "123" };
    const result = common.replaceCommandTemplate(template, vars);
    assert.strictEqual(result, "cmd 123 ");
  });

  it("Numeric variables are converted to strings", () => {
    const template = "cmd <channel> <count>";
    const vars = { channel: "123", count: 42 };
    const result = common.replaceCommandTemplate(template, vars);
    assert.strictEqual(result, "cmd 123 42");
  });

  it("Template without variables", () => {
    const template = "cmd --arg1 --arg2";
    const vars = { channel: "123" };
    const result = common.replaceCommandTemplate(template, vars);
    assert.strictEqual(result, "cmd --arg1 --arg2");
  });

  it("Variables containing quotes", () => {
    const template = "cmd <channel> <quotedVar>";
    const vars = { channel: "123", quotedVar: "\"quoted value\"" };
    const result = common.replaceCommandTemplate(template, vars);
    assert.strictEqual(result, "cmd 123 \"quoted value\"");
  });

  it("Variables containing spaces", () => {
    const template = "cmd <channel> <spacedVar>";
    const vars = { channel: "123", spacedVar: "value with spaces" };
    const result = common.replaceCommandTemplate(template, vars);
    assert.strictEqual(result, "cmd 123 value with spaces");
  });
});

describe("[command.spec] common.ts: parseCommandForSpawn()", () => {
  it("Basic command splitting", () => {
    const cmdString = "cmd arg1 arg2";
    const result = common.parseCommandForSpawn(cmdString);
    assert.deepStrictEqual(result, {
      command: "cmd",
      args: ["arg1", "arg2"]
    });
  });

  it("Command without arguments", () => {
    const cmdString = "cmd";
    const result = common.parseCommandForSpawn(cmdString);
    assert.deepStrictEqual(result, {
      command: "cmd",
      args: []
    });
  });

  it("Command containing double quotes", () => {
    const cmdString = "cmd arg1 \"arg with space\"";
    const result = common.parseCommandForSpawn(cmdString);
    assert.deepStrictEqual(result, {
      command: "cmd",
      args: ["arg1", "arg with space"]
    });
  });

  it("Command containing single quotes", () => {
    const cmdString = "cmd arg1 'arg with space'";
    const result = common.parseCommandForSpawn(cmdString);
    assert.deepStrictEqual(result, {
      command: "cmd",
      args: ["arg1", "arg with space"]
    });
  });

  it("Command containing multiple quotes", () => {
    const cmdString = "cmd \"first quoted\" 'second quoted'";
    const result = common.parseCommandForSpawn(cmdString);
    assert.deepStrictEqual(result, {
      command: "cmd",
      args: ["first quoted", "second quoted"]
    });
  });

  it("Unclosed nested quotes are not processed", () => {
    const cmdString = "cmd \"outer 'inner\"";
    const result = common.parseCommandForSpawn(cmdString);
    assert.deepStrictEqual(result, {
      command: "cmd",
      args: ["outer 'inner"]
    });
  });

  it("Argument ending with a quote", () => {
    const cmdString = "cmd arg1\"";
    const result = common.parseCommandForSpawn(cmdString);
    assert.deepStrictEqual(result, {
      command: "cmd",
      args: ["arg1"]
    });
  });

  it("Single hyphen argument", () => {
    const cmdString = "cmd -";
    const result = common.parseCommandForSpawn(cmdString);
    assert.deepStrictEqual(result, {
      command: "cmd",
      args: ["-"]
    });
  });

  it("Consecutive spaces are treated as a single separator", () => {
    const cmdString = "cmd  arg1   arg2";
    const result = common.parseCommandForSpawn(cmdString);
    assert.deepStrictEqual(result, {
      command: "cmd",
      args: ["arg1", "arg2"]
    });
  });

  it("Empty command string throws an error", () => {
    const cmdString = "";
    assert.throws(() => {
      common.parseCommandForSpawn(cmdString);
    }, /Invalid command string/);
  });
});

describe("[command.spec] Combination test: replaceCommandTemplate() + parseCommandForSpawn()", () => {
  it("Example tuner command and channel variable replacement", () => {
    const template = "cmd <channel> --arg1 --arg2 <exampleArg1> <exampleArg2> \"<white_space>\" -";
    const vars = {
      channel: "123",
      exampleArg1: "-arg0 -arg1=example",
      exampleArg2: "-arg2 \"whitespace is now supported using quote\"",
      white_space: "value with spaces"
    };

    // Replace template with replaceCommandTemplate
    const replacedCmd = common.replaceCommandTemplate(template, vars);
    assert.strictEqual(
      replacedCmd,
      "cmd 123 --arg1 --arg2 -arg0 -arg1=example -arg2 \"whitespace is now supported using quote\" \"value with spaces\" -"
    );

    // Parse the replaced string with parseCommandForSpawn
    const parsedCmd = common.parseCommandForSpawn(replacedCmd);
    assert.deepStrictEqual(parsedCmd, {
      command: "cmd",
      args: [
        "123",
        "--arg1",
        "--arg2",
        "-arg0",
        "-arg1=example",
        "-arg2",
        "whitespace is now supported using quote",
        "value with spaces",
        "-"
      ]
    });
  });

  it("Variable replacement inside quotes is correctly parsed by parseCommandForSpawn", () => {
    const template = "cmd \"<quotedVar>\"";
    const vars = {
      quotedVar: "value inside quotes"
    };

    const replacedCmd = common.replaceCommandTemplate(template, vars);
    assert.strictEqual(replacedCmd, "cmd \"value inside quotes\"");

    const parsedCmd = common.parseCommandForSpawn(replacedCmd);
    assert.deepStrictEqual(parsedCmd, {
      command: "cmd",
      args: ["value inside quotes"]
    });
  });

  it("Complex combination test", () => {
    const template = "cmd <channel> --config=\"<configPath>\" '<otherArg>'";
    const vars = {
      channel: "123",
      configPath: "/path/with spaces/config.json",
      otherArg: "arg with 'nested' quotes"
    };

    const replacedCmd = common.replaceCommandTemplate(template, vars);
    assert.strictEqual(
      replacedCmd,
      "cmd 123 --config=\"/path/with spaces/config.json\" 'arg with 'nested' quotes'"
    );

    const parsedCmd = common.parseCommandForSpawn(replacedCmd);
    assert.deepStrictEqual(parsedCmd, {
      command: "cmd",
      args: [
        "123",
        "--config=/path/with spaces/config.json",
        "arg with nested quotes"
      ]
    });
    // Note: Adjusted test case based on the implementation behavior of parseCommandForSpawn
  });

  it("Test when variables are empty", () => {
    const template = "cmd <channel> <emptyVar> <nullVar>";
    const vars = {
      channel: "123",
      emptyVar: "",
      nullVar: null
    };

    const replacedCmd = common.replaceCommandTemplate(template, vars);
    assert.strictEqual(replacedCmd, "cmd 123  null");

    const parsedCmd = common.parseCommandForSpawn(replacedCmd);
    assert.deepStrictEqual(parsedCmd, {
      command: "cmd",
      args: ["123", "null"]
    });
  });

  it("Test based on YAML example", () => {
    // Test based on the information provided in the example
    const template = "cmd <channel> --arg1 --arg2 <exampleArg1> <exampleArg2> \"<exampleArg3>\" --arg4 <exampleArg4> <exampleArg5> -";
    const vars = {
      channel: "123",
      exampleArg1: "-arg0 -arg1=example",
      exampleArg2: "-arg2 \"whitespace support using quote\"",
      exampleArg3: "white space",
      exampleArg4: 1234,
      exampleArg5: "-arg5    extra-spaces    "
    };

    const replacedCmd = common.replaceCommandTemplate(template, vars);
    const parsedCmd = common.parseCommandForSpawn(replacedCmd);

    assert.deepStrictEqual(parsedCmd, {
      command: "cmd",
      args: [
        "123",
        "--arg1",
        "--arg2",
        "-arg0",
        "-arg1=example",
        "-arg2",
        "whitespace support using quote",
        "white space",
        "--arg4",
        "1234",
        "-arg5",
        "extra-spaces",
        "-"
      ]
    });
  });
});
