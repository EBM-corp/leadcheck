#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runPageChecks } from "./checks.js";
import { probeValidation, probeEnforcement, PROBE_MARKER } from "./probe.js";

const C = process.stdout.isTTY
  ? { dim:"\x1b[2m", red:"\x1b[31m", yellow:"\x1b[33m", green:"\x1b[32m", cyan:"\x1b[36m", bold:"\x1b[1m", off:"\x1b[0m" }
  : { dim:"", red:"", yellow:"", green:"", cyan:"", bold:"", off:"" };

const USAGE = `
leadcheck — find the ways a lead form fails silently

  npx leadcheck <url> [options]

Options
  --endpoint <url>        also probe the form's API endpoint (sends {} — cannot store)
  --probe-enforcement     additionally test whether the anti-bot token is enforced.
                          WRITES A ROW if it is not — marked "${PROBE_MARKER}".
  --json                  machine-readable output
  --timeout <ms>          per-request timeout (default 10000)
  -h, --help

Exit codes
  0  no failures        1  at least one failure        2  could not run

Examples
  npx leadcheck https://example.com/contact
  npx leadcheck https://example.com/contact --endpoint https://example.com/api/contact
`;

function parseArgs(argv) {
  const args = { url: null, endpoint: null, probeEnforcement: false, json: false, timeoutMs: 10000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    else if (a === "--json") args.json = true;
    else if (a === "--probe-enforcement") args.probeEnforcement = true;
    else if (a === "--endpoint") args.endpoint = argv[++i];
    else if (a === "--timeout") args.timeoutMs = Number(argv[++i]);
    else if (!a.startsWith("-") && !args.url) args.url = a;
  }
  return args;
}

const ICON = { pass: `${C.green}✓${C.off}`, fail: `${C.red}✗${C.off}`, warn: `${C.yellow}!${C.off}`, info: `${C.cyan}i${C.off}` };

function symbolFor(r) {
  if (r.passed && r.findings.length === 0) return ICON.pass;
  if (r.severity === "fail") return ICON.fail;
  if (r.severity === "warn") return ICON.warn;
  return ICON.info;
}

function render(results, url) {
  const lines = [`\n${C.bold}leadcheck${C.off} ${C.dim}${url}${C.off}\n`];
  for (const r of results) {
    lines.push(`  ${symbolFor(r)} ${r.title}${r.status ? C.dim + `  [HTTP ${r.status}]` + C.off : ""}`);
    for (const f of r.findings) lines.push(`      ${C.dim}→${C.off} ${f.detail}`);
    if (r.note) lines.push(`      ${C.dim}${r.note}${C.off}`);
    if (r.findings.length) lines.push(`      ${C.dim}fix: ${r.remedy}${C.off}`);
  }
  const failed = results.filter((r) => !r.passed && r.severity === "fail").length;
  const warned = results.filter((r) => r.findings.length && r.severity === "warn").length;
  lines.push(
    `\n  ${failed ? C.red : C.green}${failed} failing${C.off}, ${warned} warning, ` +
    `${results.length} checks\n`
  );
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.url) { console.log(USAGE); return args.help ? 0 : 2; }

  let html;
  try {
    const res = await fetch(args.url, {
      headers: { "User-Agent": "leadcheck (+https://github.com/EBM-corp/leadcheck)" },
      signal: AbortSignal.timeout(args.timeoutMs),
    });
    if (!res.ok) { console.error(`Could not fetch ${args.url} — HTTP ${res.status}`); return 2; }
    html = await res.text();
  } catch (err) {
    console.error(`Could not fetch ${args.url} — ${err?.message ?? err}`);
    return 2;
  }

  const results = runPageChecks(html);

  if (args.endpoint) {
    results.push(await probeValidation(args.endpoint, { timeoutMs: args.timeoutMs }));
    if (args.probeEnforcement) {
      results.push(await probeEnforcement(args.endpoint, { timeoutMs: args.timeoutMs }));
    }
  }

  if (args.json) console.log(JSON.stringify({ url: args.url, results }, null, 2));
  else console.log(render(results, args.url));

  return results.some((r) => !r.passed && r.severity === "fail") ? 1 : 0;
}

/*
 * Entry-point detection.
 *
 * The idiomatic `import.meta.url === \`file://${process.argv[1]}\`` is subtly
 * broken: import.meta.url is a URL, so any character needing escaping — a
 * space, a hash, a non-ASCII letter — is percent-encoded there and raw in
 * argv[1]. A user whose checkout sits in "~/My Projects/" gets a CLI that
 * exits silently with no output and no error, which is a miserable first
 * impression. Compare real paths instead.
 */
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  main().then((code) => process.exit(code));
}
