import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "fixtures/readme/first-audit-output.txt");
const check = process.argv.includes("--check");

const themes = Object.freeze({
  light: {
    background: "#f8fafc",
    border: "#cbd5e1",
    chrome: "#e2e8f0",
    text: "#0f172a",
    muted: "#475569",
    accent: "#b45309",
  },
  dark: {
    background: "#0f172a",
    border: "#334155",
    chrome: "#1e293b",
    text: "#e2e8f0",
    muted: "#94a3b8",
    accent: "#fbbf24",
  },
});

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function render(lines, colors) {
  const text = lines.map((line, index) => {
    const y = 76 + (index * 24);
    const role = line === "Inconclusive" ? "accent" : line.startsWith("web.") ? "muted" : "text";
    return `  <text x="32" y="${y}" class="${role}">${escapeXml(line || " ")}</text>`;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 488" role="img" aria-labelledby="title description">
  <title id="title">Representative LaunchRally audit output</title>
  <desc id="description">An Inconclusive audit with no failed findings, three verification gaps, and rally init as the next command.</desc>
  <rect width="440" height="488" rx="18" fill="${colors.background}"/>
  <rect x="1" y="1" width="438" height="486" rx="17" fill="none" stroke="${colors.border}" stroke-width="2"/>
  <path d="M18 0h404a18 18 0 0 1 18 18v38H0V18A18 18 0 0 1 18 0Z" fill="${colors.chrome}"/>
  <circle cx="28" cy="28" r="6" fill="#ef4444"/>
  <circle cx="50" cy="28" r="6" fill="#f59e0b"/>
  <circle cx="72" cy="28" r="6" fill="#22c55e"/>
  <style>
    text { font: 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: ${colors.text}; }
    .muted { fill: ${colors.muted}; }
    .accent { fill: ${colors.accent}; font-weight: 700; }
  </style>
${text}
</svg>
`;
}

const lines = (await readFile(fixturePath, "utf8")).trimEnd().split("\n");
let stale = false;

for (const [theme, colors] of Object.entries(themes)) {
  const destination = path.join(root, `docs/assets/launchrally-terminal-${theme}.svg`);
  const expected = render(lines, colors);
  if (check) {
    const actual = await readFile(destination, "utf8").catch(() => "");
    if (actual !== expected) {
      stale = true;
      process.stderr.write(`${path.relative(root, destination)} is stale; regenerate it.\n`);
    }
  } else {
    await writeFile(destination, expected);
  }
}

if (stale) {
  process.exitCode = 1;
}
