#!/usr/bin/env node
"use strict";

/*
 * eval-query - run the old-vs-current retrieval comparison for one or more
 * queries without typing the full python invocation.
 *
 * Usage:
 *   npm run eval-query -- "SetVariable Attributes NV"
 *   npm run eval-query -- "UEFI boot flow PEI DXE" --query "PcdDebugPrintErrorLevel"
 *   npm run eval-query -- "query" --data-dir C:\path\to\kb\data
 *
 * Resolution order:
 *   python    - $EDK2_KB_PYTHON, else <kb dir>\venv\Scripts\python.exe
 *               (<kb dir> = parent of the data dir), else `python` on PATH
 *   data dir  - --data-dir, else ~/.edk2-opencode/kb/data, else
 *               <package>/edk2-kb/data
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function stripQuotes(s) {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1);
  }
  return s;
}

function parseArgs(argv) {
  const queries = [];
  let dataDir = null;
  for (let i = 0; i < argv.length; i++) {
    const t = stripQuotes(argv[i]);
    if (t === "--data-dir") {
      dataDir = stripQuotes(argv[++i] || "");
    } else if (t.startsWith("--data-dir=")) {
      dataDir = t.slice("--data-dir=".length);
    } else if (t === "--query") {
      queries.push(stripQuotes(argv[++i] || ""));
    } else if (t.startsWith("--query=")) {
      queries.push(t.slice("--query=".length));
    } else if (!t.startsWith("-")) {
      queries.push(t);
    }
  }
  return { queries, dataDir };
}

function findPython(dataDir) {
  if (process.env.EDK2_KB_PYTHON) {
    return process.env.EDK2_KB_PYTHON;
  }
  const kbRoot = dataDir ? path.resolve(dataDir, "..") : null;
  if (kbRoot) {
    const candidates = [
      path.join(kbRoot, "venv", "Scripts", "python.exe"),
      path.join(kbRoot, ".venv", "Scripts", "python.exe"),
      path.join(kbRoot, "venv", "bin", "python"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }
  }
  return "python";
}

function findDataDir(explicit) {
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }
  const homeKb = path.join(os.homedir(), ".edk2-opencode", "kb", "data");
  if (fs.existsSync(homeKb)) {
    return homeKb;
  }
  const pkgKb = path.join(__dirname, "..", "edk2-kb", "data");
  if (fs.existsSync(pkgKb)) {
    return pkgKb;
  }
  return explicit || null;
}

function main() {
  const { queries, dataDir } = parseArgs(process.argv.slice(2));
  if (queries.length === 0) {
    console.error(
      "usage: npm run eval-query -- \"<query>\" [--data-dir <kb data dir>]");
    process.exit(2);
  }

  const script = path.join(__dirname, "..", "edk2-kb", "eval", "compare_query.py");
  if (!fs.existsSync(script)) {
    console.error("compare_query.py not found:", script);
    process.exit(1);
  }

  const resolvedDataDir = findDataDir(dataDir);
  if (!resolvedDataDir) {
    console.error(
      "No knowledge base data found. Run `npx edk2-opencode init` first,\n" +
      "or pass --data-dir <path to kb/data>.");
    process.exit(1);
  }

  const python = findPython(resolvedDataDir);
  const args = [script, "--data-dir", resolvedDataDir];
  for (const q of queries) {
    args.push("--query", q);
  }

  console.log("python   :", python);
  console.log("data dir :", resolvedDataDir);
  console.log("");

  const child = spawn(python, args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code == null ? 1 : code));
}

main();
