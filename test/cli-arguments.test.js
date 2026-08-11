import assert from "node:assert/strict";
import test from "node:test";

import {
  commandName,
  optionValue,
} from "../packages/cli/bin/cli-arguments.js";

test("Launcher and Engine command classification skips every valued option", () => {
  const valuedOptions = [
    "--answers",
    "--confirm",
    "--constraints",
    "--checks",
    "--cwd",
    "--gap",
    "--output",
    "--permissions",
    "--report",
    "--role",
    "--resume",
    "--scope",
    "--select",
    "--to",
  ];
  const arguments_ = valuedOptions.flatMap((option, index) => [
    option,
    `value-${index}`,
  ]);

  assert.equal(commandName([...arguments_, "verify"]), "verify");
  for (let index = 0; index < valuedOptions.length; index += 1) {
    assert.equal(optionValue(arguments_, valuedOptions[index]), `value-${index}`);
  }
});

test("version and help classification remains stable", () => {
  assert.equal(commandName(["audit", "--version"]), "version");
  assert.equal(commandName(["--json"]), "help");
});
