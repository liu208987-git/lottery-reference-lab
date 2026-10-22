#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { basename } from "node:path";

const defaultArgs = ["tests.test_update_ssq", "tests.test_update_dlt", "-v"];
const unittestArgs = ["-m", "unittest", ...(process.argv.slice(2).length ? process.argv.slice(2) : defaultArgs)];

const candidates = [];
if (process.env.PYTHON) candidates.push([process.env.PYTHON]);
candidates.push(["python"], ["python3"]);
if (process.platform === "win32") candidates.push(["py", "-3"]);

const attempts = [];
for (const [cmd, ...prefix] of candidates) {
  const result = spawnSync(cmd, [...prefix, ...unittestArgs], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    attempts.push(`${cmd}: ${result.error.code || result.error.message}`);
    continue;
  }

  if (result.status === 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(0);
  }

  attempts.push(`${[cmd, ...prefix].join(" ")}: exit ${result.status}`);
}

console.error(`${basename(process.argv[1])}: unable to run Python unittest`);
for (const line of attempts) console.error(`- ${line}`);
process.exit(1);
