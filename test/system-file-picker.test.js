import assert from "node:assert/strict";
import test from "node:test";

import {
  createSystemFilePicker,
  SystemFilePickerError,
} from "../packages/cli/bin/system-file-picker.js";

test("the macOS file picker probes osascript and requests the default report path", async () => {
  const calls = [];
  const runner = async (command, arguments_) => {
    calls.push({ command, arguments_ });
    if (command === "launchctl") return { stdout: "", stderr: "" };
    return arguments_.includes("return \"ready\"")
      ? { stdout: "ready\n", stderr: "" }
      : { stdout: "/work/launchrally-audit-report.json\n", stderr: "" };
  };
  const picker = createSystemFilePicker({
    platform: "darwin",
    env: {},
    defaultDirectory: "/work",
    runner,
  });

  assert.deepEqual(await picker.availability(), {
    available: true,
    provider: "osascript",
  });
  assert.equal(await picker.chooseSavePath(), "/work/launchrally-audit-report.json");
  assert.equal(calls[0].command, "launchctl");
  assert.match(calls[0].arguments_[1], /^gui\/\d+$/u);
  assert.equal(calls[1].command, "osascript");
  assert.deepEqual(calls[1].arguments_, ["-e", "return \"ready\""]);
  assert.equal(calls[2].command, "osascript");
  assert.deepEqual(calls[2].arguments_.slice(-2), [
    "/work",
    "launchrally-audit-report.json",
  ]);
});

test("the macOS file picker returns null when the user cancels", async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    if (calls === 1) return { stdout: "", stderr: "" };
    return { stdout: calls === 2 ? "ready\n" : "\n", stderr: "" };
  };
  const picker = createSystemFilePicker({
    platform: "darwin",
    env: {},
    defaultDirectory: "/work",
    runner,
  });

  assert.equal(await picker.chooseSavePath(), null);
});

test("the file picker preserves whitespace that belongs to the selected filename", async () => {
  let calls = 0;
  const picker = createSystemFilePicker({
    platform: "darwin",
    env: {},
    runner: async () => {
      calls += 1;
      if (calls === 1) return { stdout: "", stderr: "" };
      return calls === 2
        ? { stdout: "ready\n", stderr: "" }
        : { stdout: "/work/report .json \n", stderr: "" };
    },
  });

  assert.equal(await picker.chooseSavePath(), "/work/report .json ");
});

test("the Windows file picker uses PowerShell without interpolating the default path", async () => {
  const calls = [];
  const runner = async (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    if (calls.length === 1) return { stdout: "ready\n", stderr: "" };
    return { stdout: "C:\\reports\\launchrally-audit-report.json\n", stderr: "" };
  };
  const picker = createSystemFilePicker({
    platform: "win32",
    env: {},
    defaultDirectory: "C:\\reports",
    runner,
  });

  assert.deepEqual(await picker.availability(), {
    available: true,
    provider: "powershell",
  });
  assert.equal(
    await picker.chooseSavePath(),
    "C:\\reports\\launchrally-audit-report.json",
  );
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[1].command, "powershell.exe");
  assert.doesNotMatch(calls[1].arguments_.join(" "), /C:\\reports/u);
  assert.equal(calls[1].options.env.LAUNCHRALLY_SAVE_DIRECTORY, "C:\\reports");
  assert.equal(
    calls[1].options.env.LAUNCHRALLY_SAVE_FILENAME,
    "launchrally-audit-report.json",
  );
  assert.equal(calls[1].options.shell, false);
});

test("the Windows file picker falls back to PowerShell Core", async () => {
  const calls = [];
  const runner = async (command) => {
    calls.push(command);
    if (command === "powershell.exe") {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    return calls.length === 2
      ? { stdout: "ready\n", stderr: "" }
      : { stdout: "C:\\work\\launchrally-audit-report.json", stderr: "" };
  };
  const picker = createSystemFilePicker({
    platform: "win32",
    env: {},
    defaultDirectory: "C:\\work",
    runner,
  });

  assert.deepEqual(await picker.availability(), {
    available: true,
    provider: "powershell",
  });
  assert.equal(
    await picker.chooseSavePath(),
    "C:\\work\\launchrally-audit-report.json",
  );
  assert.deepEqual(calls, ["powershell.exe", "pwsh.exe", "pwsh.exe"]);
});

test("the Linux file picker uses zenity when a graphical session is available", async () => {
  const calls = [];
  const runner = async (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    if (arguments_.includes("--version")) return { stdout: "4.0.0\n", stderr: "" };
    return { stdout: "/work/launchrally-audit-report.json\n", stderr: "" };
  };
  const picker = createSystemFilePicker({
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0" },
    defaultDirectory: "/work",
    runner,
  });

  assert.deepEqual(await picker.availability(), {
    available: true,
    provider: "zenity",
  });
  assert.equal(await picker.chooseSavePath(), "/work/launchrally-audit-report.json");
  assert.deepEqual(calls.map(({ command }) => command), ["zenity", "zenity"]);
  assert.deepEqual(calls[1].arguments_, [
    "--file-selection",
    "--save",
    "--title=Save LaunchRally Audit Report",
    "--filename=/work/launchrally-audit-report.json",
    "--file-filter=JSON files | *.json",
  ]);
  assert.equal(calls[1].options.shell, false);
});

test("the Linux file picker falls back to kdialog and treats exit code 1 as cancellation", async () => {
  const calls = [];
  const runner = async (command, arguments_) => {
    calls.push({ command, arguments_ });
    if (command === "zenity") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (arguments_.includes("--version")) return { stdout: "kdialog 24.02\n", stderr: "" };
    throw Object.assign(new Error("cancelled"), { code: 1 });
  };
  const picker = createSystemFilePicker({
    platform: "linux",
    env: { DISPLAY: ":0" },
    defaultDirectory: "/work",
    runner,
  });

  assert.deepEqual(await picker.availability(), {
    available: true,
    provider: "kdialog",
  });
  assert.equal(await picker.chooseSavePath(), null);
  assert.deepEqual(calls.map(({ command }) => command), ["zenity", "kdialog", "kdialog"]);
  assert.deepEqual(calls[2].arguments_, [
    "--getsavefilename",
    "/work/launchrally-audit-report.json",
    "JSON files (*.json)",
    "--title",
    "Save LaunchRally Audit Report",
  ]);
});

test("the file picker does not probe native tools without a usable GUI session", async (context) => {
  const cases = [
    { platform: "darwin", env: { CI: "1" } },
    { platform: "darwin", env: { SSH_CONNECTION: "client server" } },
    { platform: "win32", env: { SESSIONNAME: "Services" } },
    { platform: "linux", env: {} },
  ];
  for (const entry of cases) {
    await context.test(entry.platform, async () => {
      let calls = 0;
      const picker = createSystemFilePicker({
        ...entry,
        runner: async () => {
          calls += 1;
          return { stdout: "ready", stderr: "" };
        },
      });

      assert.deepEqual(await picker.availability(), {
        available: false,
        reason: "no_gui_session",
      });
      assert.equal(calls, 0);
      await assert.rejects(
        picker.chooseSavePath(),
        (error) => error instanceof SystemFilePickerError
          && error.code === "file_picker_unavailable",
      );
    });
  }
});

test("the file picker treats an explicitly false CI flag as a local session", async () => {
  let calls = 0;
  const picker = createSystemFilePicker({
    platform: "darwin",
    env: { CI: "false" },
    runner: async () => {
      calls += 1;
      return { stdout: calls === 1 ? "" : "ready", stderr: "" };
    },
  });

  assert.deepEqual(await picker.availability(), {
    available: true,
    provider: "osascript",
  });
  assert.equal(calls, 2);
});

test("the file picker rejects headless macOS and Windows sessions after native probing", async () => {
  const mac = createSystemFilePicker({
    platform: "darwin",
    env: {},
    runner: async (command) => {
      if (command === "launchctl") throw Object.assign(new Error("no Aqua session"), { code: 113 });
      return { stdout: "ready", stderr: "" };
    },
  });
  const windows = createSystemFilePicker({
    platform: "win32",
    env: {},
    runner: async () => ({ stdout: "no_gui", stderr: "" }),
  });

  assert.deepEqual(await mac.availability(), {
    available: false,
    reason: "no_gui_session",
  });
  assert.deepEqual(await windows.availability(), {
    available: false,
    reason: "no_gui_session",
  });
});

test("the file picker reports native dialog failures separately from cancellation", async () => {
  let calls = 0;
  const picker = createSystemFilePicker({
    platform: "darwin",
    env: {},
    defaultDirectory: "/work",
    runner: async () => {
      calls += 1;
      if (calls === 1) return { stdout: "", stderr: "" };
      if (calls === 2) return { stdout: "ready", stderr: "" };
      throw Object.assign(new Error("native failure"), { code: 2 });
    },
  });

  await assert.rejects(
    picker.chooseSavePath(),
    (error) => error instanceof SystemFilePickerError
      && error.code === "file_picker_failed"
      && error.cause?.message === "native failure",
  );
});

test("the file picker distinguishes unsupported platforms from missing dialog tools", async () => {
  let unsupportedCalls = 0;
  const unsupported = createSystemFilePicker({
    platform: "aix",
    env: {},
    runner: async () => {
      unsupportedCalls += 1;
      return { stdout: "", stderr: "" };
    },
  });
  const missing = createSystemFilePicker({
    platform: "linux",
    env: { DISPLAY: ":0" },
    runner: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });

  assert.deepEqual(await unsupported.availability(), {
    available: false,
    reason: "unsupported_platform",
  });
  assert.equal(unsupportedCalls, 0);
  assert.deepEqual(await missing.availability(), {
    available: false,
    reason: "dialog_tool_unavailable",
  });
});
