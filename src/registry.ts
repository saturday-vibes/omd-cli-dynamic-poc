import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Kind = 'component' | 'service';

export const kinds: Kind[] = ['component', 'service'];

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** A mistake by the caller (bad flag, unknown version). Exit code 2. */
export class UsageError extends Error {}

/** `@test-org-th/omd-schema-component` */
export function packageName(kind: Kind): string {
  return `@test-org-th/omd-schema-${kind}`;
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [SEMVER.exec(a)!.slice(1).map(Number), SEMVER.exec(b)!.slice(1).map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

export type Schema = { kind: Kind; version: string; packageName: string; schema: JsonSchema };

export type RegistryOptions = {
  /** Defaults to `$OMD_CACHE_DIR`, else `~/.omd-cli/schemas`. */
  cacheDir?: string;
  /** npm runs here so the user's project `.npmrc` (registry, auth) applies. */
  cwd?: string;
  npm?: string;
};

/**
 * Schema packages straight from the npm registry: versions come from `npm view`, and a
 * version is installed into a local cache the first time it's used.
 */
export class Registry {
  private readonly cacheDir: string;
  private readonly cwd: string;
  private readonly npm: string;

  constructor(options: RegistryOptions = {}) {
    this.cacheDir = options.cacheDir ?? process.env.OMD_CACHE_DIR ?? path.join(os.homedir(), '.omd-cli', 'schemas');
    this.cwd = options.cwd ?? process.cwd();
    this.npm = options.npm ?? 'npm';
  }

  /** Published X.Y.Z versions, newest first. */
  async versions(kind: Kind): Promise<string[]> {
    const stdout = await this.run(['view', packageName(kind), 'versions', '--json'], kind);
    const parsed = JSON.parse(stdout) as string | string[];
    return [parsed]
      .flat()
      .filter(v => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => compareVersions(b, a));
  }

  /** One version (latest when omitted), from the cache or installed into it. */
  async load(kind: Kind, version?: string): Promise<Schema> {
    if (version !== undefined && !SEMVER.test(version)) {
      throw new UsageError(`Invalid schema version: ${version}. Expected X.Y.Z or vX.Y.Z`);
    }
    const wanted = version?.replace(/^v/, '') ?? (await this.versions(kind))[0];
    if (!wanted) {
      throw new UsageError(`No ${kind} schemas are published`);
    }
    const dir = await this.install(kind, wanted);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      main?: string;
    };
    if (manifest.name !== packageName(kind) || manifest.version !== wanted) {
      throw new Error(`${dir} holds ${manifest.name}@${manifest.version}, expected ${packageName(kind)}@${wanted}`);
    }
    const schema = JSON.parse(fs.readFileSync(path.join(dir, manifest.main ?? 'index.json'), 'utf8')) as JsonSchema;
    return { kind, version: wanted, packageName: manifest.name, schema };
  }

  private async install(kind: Kind, version: string): Promise<string> {
    const target = path.join(this.cacheDir, kind, version);
    if (fs.existsSync(path.join(target, 'package.json'))) {
      return target;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = fs.mkdtempSync(path.join(this.cacheDir, '.tmp-'));
    try {
      const spec = `${packageName(kind)}@${version}`;
      await this.run(['install', spec, '--prefix', temp, '--ignore-scripts', '--no-save', '--no-package-lock', '--no-audit', '--no-fund'], kind, version);
      fs.renameSync(path.join(temp, 'node_modules', ...packageName(kind).split('/')), target);
    } catch (error) {
      // Another run finished the same install first; its copy is as good as ours.
      if (!fs.existsSync(path.join(target, 'package.json'))) throw error;
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    return target;
  }

  private async run(args: string[], kind: Kind, version?: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.npm, args, { cwd: this.cwd, timeout: 120_000 });
      return stdout;
    } catch (error) {
      const stderr = `${(error as { stderr?: string }).stderr ?? ''}`;
      if (stderr.includes('E404') || stderr.includes('ETARGET')) {
        throw new UsageError(
          version ? `${kind} schema ${version} is not published` : `${packageName(kind)} is not on the registry`,
        );
      }
      throw new Error(`npm ${args[0]} failed: ${stderr.trim().split('\n').slice(-3).join(' ') || (error as Error).message}`);
    }
  }
}
