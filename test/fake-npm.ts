import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A stand-in for npm that knows component 1.0.0 and 1.2.0 and nothing else.
 * `view <pkg> versions --json` lists them; `install <pkg>@<v> --prefix <dir>` writes the
 * package into <dir>/node_modules. Every call is appended to <dir>/calls.
 */
export function fakeNpm(dir: string): { npm: string; calls: () => string[] } {
  const log = path.join(dir, 'calls');
  const npm = path.join(dir, 'npm');
  fs.writeFileSync(
    npm,
    `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.slice(0, 2).join(' ') + '\\n');
const published = { '@test-org-th/omd-schema-component': ['1.0.0', '1.2.0', '0.0.0-stage'] };
const fail = () => { process.stderr.write('npm error code E404\\n'); process.exit(1); };
if (args[0] === 'view') {
  if (!published[args[1]]) fail();
  process.stdout.write(JSON.stringify(published[args[1]]));
} else {
  const at = args[1].lastIndexOf('@');
  const name = args[1].slice(0, at), version = args[1].slice(at + 1);
  if (!(published[name] || []).includes(version)) fail();
  const out = path.join(args[3], 'node_modules', ...name.split('/'));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name, version, main: 'schema.json' }));
  const properties = { name: { type: 'string' } };
  if (version === '1.2.0') properties.tier = { type: 'string', enum: ['gold', 'silver'] };
  fs.writeFileSync(path.join(out, 'schema.json'), JSON.stringify({ type: 'object', required: ['name'], properties }));
}
`,
    { mode: 0o755 },
  );
  return { npm, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}
