// Heroa TS SDK lint — substitutes for ESLint because the installed ESLint
// version (6.4) predates TypeScript support and no @typescript-eslint parser
// is available in the toolchain. tsc --noEmit --strict already catches type
// errors; this script catches the cross-cutting rules ESLint would enforce:
//   - no `any`
//   - no `// TODO` / `// FIXME`
//   - no `console.log` in non-test sources
//   - no trailing whitespace / tabs
//
// Runs over sdk/typescript/src/*.ts. Exits 1 on any finding.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../src/", import.meta.url);
const rootPath = decodeURIComponent(root.pathname);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = walk(rootPath);
const findings = [];

for (const f of files) {
  const isTest = f.endsWith(".test.ts");
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const loc = `${f}:${i + 1}`;
    // Allow `as any` nowhere; `any` type refs also forbidden.
    if (/[^a-zA-Z0-9_]any\b/.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*")) {
      findings.push(`${loc}: disallowed 'any' type`);
    }
    if (/\bTODO\b/.test(line) || /\bFIXME\b/.test(line)) {
      findings.push(`${loc}: TODO/FIXME marker`);
    }
    if (!isTest && /\bconsole\.(log|debug)\b/.test(line)) {
      findings.push(`${loc}: console.log/debug in non-test source`);
    }
    if (line.endsWith(" ") || line.endsWith("\t")) {
      findings.push(`${loc}: trailing whitespace`);
    }
    if (/\t/.test(line)) {
      findings.push(`${loc}: tab character (use spaces)`);
    }
  }
}

if (findings.length > 0) {
  for (const f of findings) process.stderr.write(f + "\n");
  process.exit(1);
}
process.exit(0);
