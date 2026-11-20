import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { listFields } from './fields';
import type { Kind } from './registry';
import { kinds, packageName, Registry, UsageError } from './registry';
import { runValidate, type ValidateFlags } from './validate';

export type Result = { exitCode: number; stdout: string; stderr: string };

type Output = { json?: boolean };

function version(): string {
  const manifest = path.join(__dirname, '..', 'package.json');
  return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string }).version;
}

export async function runCli(argv: string[], registry: Registry = new Registry()): Promise<Result> {
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  const print = (text: string) => (stdout += text.endsWith('\n') ? text : `${text}\n`);
  const kindOption = () => new Option('--kind <kind>', 'schema kind').choices(kinds);
  const jsonOption = () => new Option('--json', 'print JSON');

  const program = new Command('omd')
    .description('POC: OMD schemas downloaded from the registry at runtime.')
    .version(version())
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: s => (stdout += s), writeErr: s => (stderr += s) });

  const schema = program.command('schema').description('Inspect the OMD schemas published on the registry.');

  schema
    .command('versions')
    .description('List the published schema versions, newest first.')
    .addOption(kindOption())
    .addOption(jsonOption())
    .action(async ({ kind, json }: Output & { kind?: Kind }) => {
      const selected = kind ? [kind] : kinds;
      const entries = await Promise.all(selected.map(async k => [k, (await registry.versions(k)).map(v => `v${v}`)] as const));
      if (json) {
        print(JSON.stringify(Object.fromEntries(entries), null, 2));
      } else {
        for (const [k, versions] of entries) print(`${k} (${packageName(k)}): ${versions.join(', ') || 'none'}`);
      }
    });

  schema
    .command('show')
    .description('List the fields of a schema version, downloading it on first use.')
    .addOption(kindOption().default('component'))
    .addOption(new Option('--version <version>', 'schema version, e.g. 1.4.4 or v1.4.4 (default: latest)'))
    .addOption(jsonOption())
    .action(async ({ kind, version: wanted, json }: Output & { kind: Kind; version?: string }) => {
      const loaded = await registry.load(kind, wanted);
      const fields = listFields(loaded.schema);
      if (json) {
        print(JSON.stringify({ kind, version: `v${loaded.version}`, package: `${loaded.packageName}@${loaded.version}`, fields }, null, 2));
        return;
      }
      print(`${kind} schema v${loaded.version} (${loaded.packageName}@${loaded.version})\n`);
      for (const f of fields) {
        print(`${f.path}${f.required ? ' *' : ''}  ${f.type}${f.enum ? `  [${f.enum.join(', ')}]` : ''}`);
      }
    });

  program
    .command('validate')
    .description('Validate a repository .omd folder, or one now.yaml, including the action Backstage rules.')
    .argument('[path]', 'repository root or one now.yaml')
    .addOption(new Option('--format <format>', 'output format').choices(['json', 'text']).default('json'))
    .addOption(new Option('--no-download', 'fail instead of downloading a schema version that is not cached'))
    .addOption(new Option('--skip-backstage', 'JSON Schema only. Skips the Backstage lookups the action runs.'))
    .addOption(new Option('--repo <owner/name>', 'repository slug for name and uniqueness checks. Defaults to GITHUB_REPOSITORY, then the git remote.'))
    .addOption(new Option('--backstage-url <url>', 'Backstage base URL. Defaults to OMD_BACKSTAGE_URL.'))
    .action(async (target: string | undefined, flags: ValidateFlags) => {
      const outcome = await runValidate(target ?? process.cwd(), flags, registry);
      stdout += outcome.stdout;
      stderr += outcome.stderr;
      exitCode = outcome.exitCode;
    });

  try {
    await program.parseAsync(argv);
    return { exitCode, stdout, stderr };
  } catch (error) {
    if (error instanceof CommanderError) {
      return { exitCode: error.exitCode === 0 ? 0 : 2, stdout, stderr };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: error instanceof UsageError ? 2 : 1, stdout, stderr: `${stderr}${message}\n` };
  }
}
