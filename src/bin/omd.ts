#!/usr/bin/env node
import { runCli } from '../cli';

void runCli(process.argv).then(({ exitCode, stdout, stderr }) => {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = exitCode;
});
