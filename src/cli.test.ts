import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from './cli';
import { Registry } from './registry';
import { fakeNpm } from '../test/fake-npm';

describe('omd schema', () => {
  let temp: string;
  let npm: ReturnType<typeof fakeNpm>;
  let registry: Registry;
  const run = (...args: string[]) => runCli(['node', 'omd', 'schema', ...args], registry);

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-'));
    npm = fakeNpm(temp);
    registry = new Registry({ npm: npm.npm, cacheDir: path.join(temp, 'cache') });
  });

  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

  it('lists published versions newest first, without pre-releases', async () => {
    const result = await run('versions', '--kind', 'component', '--json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ component: ['v1.2.0', 'v1.0.0'] });
  });

  it('shows the latest version by default', async () => {
    const result = await run('show', '--json');
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: 'v1.2.0',
      fields: [{ path: 'name', required: true }, { path: 'tier', enum: ['gold', 'silver'] }],
    });
  });

  it('downloads a version once, then reads it from the cache', async () => {
    await run('show', '--version', 'v1.0.0');
    const second = await run('show', '--version', '1.0.0');

    expect(second.stdout).toContain('component schema v1.0.0');
    expect(npm.calls().filter(call => call.startsWith('install'))).toHaveLength(1);
    expect(fs.existsSync(path.join(temp, 'cache', 'component', '1.0.0', 'schema.json'))).toBe(true);
  });

  it('exits 2 for a version that is not published', async () => {
    const result = await run('show', '--version', '9.9.9');
    expect(result).toMatchObject({ exitCode: 2, stderr: 'component schema 9.9.9 is not published\n' });
  });

  it('exits 2 for a package that is not on the registry', async () => {
    const result = await run('versions', '--kind', 'service');
    expect(result).toMatchObject({ exitCode: 2, stderr: '@test-org-th/omd-schema-service is not on the registry\n' });
  });

  it('exits 2 for a version that is not X.Y.Z', async () => {
    const result = await run('show', '--version', 'latest');
    expect(result.exitCode).toBe(2);
    expect(npm.calls()).toEqual([]);
  });
});
