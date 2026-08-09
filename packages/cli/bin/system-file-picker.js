import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_REPORT_FILENAME = "launchrally-audit-report.json";

const FALSE_ENV_VALUES = new Set(["0", "false", "no"]);
const SUPPORTED_PLATFORMS = new Set(["darwin", "win32", "linux"]);

export class SystemFilePickerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "SystemFilePickerError";
    this.code = code;
  }
}

const MACOS_SAVE_SCRIPT = `on run argv
  set defaultDirectory to POSIX file (item 1 of argv)
  set defaultName to item 2 of argv
  try
    set selectedFile to choose file name with prompt "Save LaunchRally Audit Report" default location defaultDirectory default name defaultName
    return POSIX path of selectedFile
  on error number -128
    return ""
  end try
end run`;

const WINDOWS_PROBE_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "if (-not [Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) { [Console]::Out.Write('no_gui'); exit 0 }",
  "[Console]::Out.Write('ready')",
].join("; ");

const WINDOWS_PROBE_ARGUMENTS = Object.freeze([
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-STA",
  "-Command",
  WINDOWS_PROBE_SCRIPT,
]);

const WINDOWS_SAVE_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dialog = New-Object System.Windows.Forms.SaveFileDialog",
  "$dialog.Title = 'Save LaunchRally Audit Report'",
  "$dialog.InitialDirectory = [Environment]::GetEnvironmentVariable('LAUNCHRALLY_SAVE_DIRECTORY', 'Process')",
  "$dialog.FileName = [Environment]::GetEnvironmentVariable('LAUNCHRALLY_SAVE_FILENAME', 'Process')",
  "$dialog.Filter = 'JSON files (*.json)|*.json|All files (*.*)|*.*'",
  "$dialog.DefaultExt = 'json'",
  "$dialog.AddExtension = $true",
  "$dialog.OverwritePrompt = $false",
  "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }",
].join("; ");

function defaultRunner(command, arguments_, options) {
  return execFileAsync(command, arguments_, options);
}

function environmentFlag(value) {
  return Boolean(value) && !FALSE_ENV_VALUES.has(String(value).toLowerCase());
}

function hasGuiSession(platform, env) {
  if (environmentFlag(env.CI)) return false;
  if (environmentFlag(env.SSH_CONNECTION) || environmentFlag(env.SSH_TTY)) return false;
  if (platform === "linux") return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  if (platform === "win32" && env.SESSIONNAME?.toLowerCase() === "services") return false;
  return true;
}

function selectedPath(stdout) {
  const value = String(stdout).replace(/\r?\n$/u, "");
  return value === "" ? null : value;
}

function rethrowPickerAbort(error, signal) {
  if (signal?.aborted) signal.throwIfAborted();
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
}

export function createSystemFilePicker({
  platform = process.platform,
  env = process.env,
  defaultDirectory = process.cwd(),
  runner = defaultRunner,
  userId = process.getuid?.(),
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const directory = pathApi.resolve(defaultDirectory);
  let availabilityPromise;
  let selectedCommand;

  const runOptions = Object.freeze({
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const cancellableRunOptions = (signal) => signal ? { ...runOptions, signal } : runOptions;

  async function availability({ signal } = {}) {
    signal?.throwIfAborted();
    availabilityPromise ??= (async () => {
      if (!SUPPORTED_PLATFORMS.has(platform)) {
        return { available: false, reason: "unsupported_platform" };
      }
      if (!hasGuiSession(platform, env)) {
        return { available: false, reason: "no_gui_session" };
      }
      if (platform === "darwin") {
        if (userId === undefined) return { available: false, reason: "no_gui_session" };
        try {
          await runner(
            "launchctl",
            ["print", `gui/${userId}`],
            cancellableRunOptions(signal),
          );
        } catch (error) {
          rethrowPickerAbort(error, signal);
          return { available: false, reason: "no_gui_session" };
        }
        try {
          const probe = await runner(
            "osascript",
            ["-e", "return \"ready\""],
            cancellableRunOptions(signal),
          );
          if (selectedPath(probe.stdout) !== "ready") {
            return { available: false, reason: "dialog_tool_unavailable" };
          }
          selectedCommand = "osascript";
          return { available: true, provider: "osascript" };
        } catch (error) {
          rethrowPickerAbort(error, signal);
          return { available: false, reason: "dialog_tool_unavailable" };
        }
      }
      const candidates = platform === "win32"
        ? ["powershell.exe", "pwsh.exe"].map((command) => ({
          command,
          arguments_: WINDOWS_PROBE_ARGUMENTS,
          provider: "powershell",
        }))
        : [
          { command: "zenity", arguments_: ["--version"], provider: "zenity" },
          { command: "kdialog", arguments_: ["--version"], provider: "kdialog" },
        ];
      for (const candidate of candidates) {
        try {
          const probe = await runner(
            candidate.command,
            candidate.arguments_,
            cancellableRunOptions(signal),
          );
          const probeValue = selectedPath(probe.stdout);
          if (platform === "win32" && probeValue === "no_gui") {
            return { available: false, reason: "no_gui_session" };
          }
          if (platform === "win32" && probeValue !== "ready") continue;
          selectedCommand = candidate.command;
          return { available: true, provider: candidate.provider };
        } catch (error) {
          rethrowPickerAbort(error, signal);
          // Try the next direct executable without invoking a command shell.
        }
      }
      return { available: false, reason: "dialog_tool_unavailable" };
    })();
    return availabilityPromise;
  }

  async function chooseSavePath({ signal } = {}) {
    signal?.throwIfAborted();
    const state = await availability({ signal });
    if (!state.available) {
      throw new SystemFilePickerError(
        "file_picker_unavailable",
        `System file picker is unavailable: ${state.reason}.`,
      );
    }
    let arguments_;
    if (platform === "darwin") {
      arguments_ = ["-e", MACOS_SAVE_SCRIPT, directory, DEFAULT_REPORT_FILENAME];
    } else if (platform === "win32") {
      arguments_ = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        WINDOWS_SAVE_SCRIPT,
      ];
    } else if (selectedCommand === "zenity") {
      arguments_ = [
        "--file-selection",
        "--save",
        "--title=Save LaunchRally Audit Report",
        `--filename=${pathApi.join(directory, DEFAULT_REPORT_FILENAME)}`,
        "--file-filter=JSON files | *.json",
      ];
    } else {
      arguments_ = [
        "--getsavefilename",
        pathApi.join(directory, DEFAULT_REPORT_FILENAME),
        "JSON files (*.json)",
        "--title",
        "Save LaunchRally Audit Report",
      ];
    }
    try {
      const options = platform === "win32"
        ? {
          ...runOptions,
          ...(signal ? { signal } : {}),
          env: {
            ...env,
            LAUNCHRALLY_SAVE_DIRECTORY: directory,
            LAUNCHRALLY_SAVE_FILENAME: DEFAULT_REPORT_FILENAME,
          },
        }
        : cancellableRunOptions(signal);
      const result = await runner(selectedCommand, arguments_, options);
      return selectedPath(result.stdout);
    } catch (error) {
      rethrowPickerAbort(error, signal);
      if (platform === "linux" && error?.code === 1) return null;
      throw new SystemFilePickerError(
        "file_picker_failed",
        "The system file picker failed.",
        { cause: error },
      );
    }
  }

  return Object.freeze({ availability, chooseSavePath });
}
