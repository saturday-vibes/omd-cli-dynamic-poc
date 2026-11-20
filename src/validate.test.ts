import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { BackstageClient } from './backstage';
import { runCli } from './cli';
import type { Kind } from './registry';
import { Registry } from './registry';
import { compileDocument, ignoredKeywords, validationOutcome } from './rules';
import { fakeNpm } from '../test/fake-npm';

const fixtures = path.join(__dirname, '..', 'test', 'fixtures');
const repo = path.join(__dirname, '..', 'test', 'repos', 'service-catalog-backstage');

const SERVICE_SCHEMA = {
  type: 'object',
  required: ['schema_version', 'omd_service'],
  properties: {
    schema_version: { type: 'string' },
    omd_service: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  },
};

const COMPONENT_SCHEMA = {
  type: 'object',
  required: ['schema_version', 'omd_component'],
  properties: {
    schema_version: { type: 'string' },
    omd_service: { type: 'string' },
    omd_component: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  },
};

function seed(cacheDir: string, kind: Kind, version: string, schema: object): void {
  const dir = path.join(cacheDir, kind, version);
  const main = kind === 'component' ? 'OmdComponent.json' : 'OmdService.json';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: `@test-org-th/omd-schema-${kind}`, version, main }),
  );
  fs.writeFileSync(path.join(dir, main), JSON.stringify(schema));
}

function writeYaml(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

describe('validate', () => {
  let temp: string;
  let npm: ReturnType<typeof fakeNpm>;
  let registry: Registry;
  const run = (...args: string[]) => runCli(['node', 'omd', 'validate', ...args], registry);

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-validate-'));
    npm = fakeNpm(temp);
    registry = new Registry({ npm: npm.npm, cacheDir: path.join(temp, 'cache') });
  });

  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

  it('exits 2 when the path does not exist', async () => {
    const outcome = await run(path.join(temp, 'missing.yaml'));
    expect(outcome.exitCode).toBe(2);
    expect(JSON.parse(outcome.stdout).error).toMatch(/No such file/);
  });

  it('exits 2 when a directory has no .omd folder', async () => {
    const outcome = await run(temp);
    expect(outcome.exitCode).toBe(2);
    expect(JSON.parse(outcome.stdout).error).toMatch(/missing \.omd folder/);
  });

  it('requires Backstage credentials unless --skip-backstage is set', async () => {
    const file = path.join(temp, 'now.yaml');
    writeYaml(file, 'schema_version: v1.0.0\n');
    const saved = { url: process.env.OMD_BACKSTAGE_URL, secret: process.env.OMD_BACKSTAGE_SECRET };
    delete process.env.OMD_BACKSTAGE_URL;
    delete process.env.OMD_BACKSTAGE_SECRET;
    try {
      const outcome = await run(file);
      expect(outcome.exitCode).toBe(2);
      expect(JSON.parse(outcome.stdout).error).toMatch(/OMD_BACKSTAGE_URL/);
    } finally {
      if (saved.url === undefined) delete process.env.OMD_BACKSTAGE_URL;
      else process.env.OMD_BACKSTAGE_URL = saved.url;
      if (saved.secret === undefined) delete process.env.OMD_BACKSTAGE_SECRET;
      else process.env.OMD_BACKSTAGE_SECRET = saved.secret;
    }
  });

  it('exits 2 for a version that is not X.Y.Z without calling npm', async () => {
    const file = path.join(temp, 'now.yaml');
    writeYaml(file, 'schema_version: latest\nomd_component:\n  name: api\n');
    const outcome = await run(file, '--skip-backstage');
    expect(outcome.exitCode).toBe(2);
    expect(JSON.parse(outcome.stdout).error).toMatch(/Invalid schema version/);
    expect(npm.calls()).toEqual([]);
  });

  it('exits 2 for a version that is not published', async () => {
    const file = path.join(temp, 'now.yaml');
    writeYaml(file, 'schema_version: v9.9.9\nomd_component:\n  name: api\n');
    const outcome = await run(file, '--skip-backstage');
    expect(outcome).toMatchObject({ exitCode: 2 });
    expect(JSON.parse(outcome.stdout).error).toMatch(/component schema 9\.9\.9 is not published/);
  });

  it('does not call npm when --no-download and the version is not cached', async () => {
    const file = path.join(temp, 'now.yaml');
    writeYaml(file, 'schema_version: v1.4.4\nomd_component:\n  name: api\n');
    const outcome = await run(file, '--skip-backstage', '--no-download');
    expect(outcome.exitCode).toBe(2);
    expect(JSON.parse(outcome.stdout).error).toMatch(/not cached/);
    expect(npm.calls()).toEqual([]);
  });

  it('validates a cached schema, then reports a folder name that does not match', async () => {
    const cacheDir = path.join(temp, 'cache');
    seed(cacheDir, 'service', '1.0.0', SERVICE_SCHEMA);
    seed(cacheDir, 'component', '1.0.0', COMPONENT_SCHEMA);
    const root = path.join(temp, 'repo');
    writeYaml(path.join(root, '.omd', 'now.yaml'), 'schema_version: v1.0.0\nomd_service:\n  name: demo\n');
    writeYaml(
      path.join(root, '.omd', 'api', 'now.yaml'),
      'schema_version: v1.0.0\nomd_service: demo\nomd_component:\n  name: api\n',
    );

    const ok = await run(root, '--skip-backstage', '--repo', 'acme/demo', '--format', 'text');
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toBe(
      [
        '.omd/now.yaml: valid against service schema v1.0.0 (cache, backstage skipped)',
        '.omd/api/now.yaml: valid against component schema v1.0.0 (cache, backstage skipped)',
        '',
      ].join('\n'),
    );
    expect(npm.calls()).toEqual([]);

    writeYaml(
      path.join(root, '.omd', 'api', 'now.yaml'),
      'schema_version: v1.0.0\nomd_service: demo\nomd_component:\n  name: other\n',
    );
    const mismatch = await run(root, '--skip-backstage', '--repo', 'acme/demo', '--format', 'text');
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.stdout).toMatch(/\.omd\/now\.yaml: valid against service schema v1\.0\.0/);
    expect(mismatch.stdout).toMatch(/folder name, api, does not align with the specified OMD component name, other/);
  });

  it('reports a component name that fails the name rule', async () => {
    seed(path.join(temp, 'cache'), 'component', '1.0.0', COMPONENT_SCHEMA);
    const file = path.join(temp, 'now.yaml');
    writeYaml(file, 'schema_version: v1.0.0\nomd_service: demo\nomd_component:\n  name: API\n');
    const outcome = await run(file, '--skip-backstage', '--format', 'text');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toMatch(/lowercase letter/);
  });
});

describe('published OMD files', () => {
  jest.setTimeout(180_000);

  let cacheDir: string;
  let registry: Registry;
  const run = (...args: string[]) => runCli(['node', 'omd', 'validate', ...args], registry);

  beforeAll(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-live-'));
    registry = new Registry({ cacheDir });
  });

  afterAll(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  it('validates every now.yaml in test/repos/service-catalog-backstage', async () => {
    const outcome = await run(repo, '--skip-backstage', '--repo', 'wbd-streaming/service-catalog-backstage', '--format', 'text');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe('');
    expect(outcome.stdout).toBe(
      [
        '.omd/now.yaml: valid against service schema v1.2.1 (downloaded, backstage skipped)',
        '.omd/backstage/now.yaml: valid against component schema v1.4.5 (downloaded, backstage skipped)',
        '.omd/backstage-aurora/now.yaml: valid against component schema v1.4.4 (downloaded, backstage skipped)',
        '.omd/backstage-elasticache/now.yaml: valid against component schema v1.4.0 (downloaded, backstage skipped)',
        '.omd/backstage-sqs/now.yaml: valid against component schema v1.3.0 (downloaded, backstage skipped)',
        '',
      ].join('\n'),
    );
  });

  it('validates the valid component fixture from the cache afterwards', async () => {
    const outcome = await run(path.join(fixtures, 'component-valid.yaml'), '--skip-backstage', '--format', 'text');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toMatch(/valid against component schema v1\.4\.4 \(cache, backstage skipped\)/);
  });

  it('reports schema errors for the invalid component fixture', async () => {
    const outcome = await run(path.join(fixtures, 'component-invalid.yaml'), '--skip-backstage');
    const result = JSON.parse(outcome.stdout);
    expect(outcome.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.schemaVersion).toBe('v1.4.4');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('fails with exit code 2 for a version that is not cached when downloads are off', async () => {
    const outcome = await run(path.join(fixtures, 'component-unknown-version.yaml'), '--skip-backstage', '--no-download');
    expect(outcome.exitCode).toBe(2);
    expect(JSON.parse(outcome.stdout).error).toMatch(/component schema 0\.0\.1 is not cached/);
    expect(fs.existsSync(path.join(cacheDir, 'component', '0.0.1'))).toBe(false);
  });

  it('keeps going through the other files when one component name does not match its folder', async () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-repo-'));
    try {
      fs.cpSync(repo, copy, { recursive: true });
      const component = path.join(copy, '.omd', 'backstage-sqs', 'now.yaml');
      fs.writeFileSync(component, fs.readFileSync(component, 'utf8').replace('name: backstage-sqs', 'name: other'));

      const outcome = await run(copy, '--skip-backstage', '--repo', 'wbd-streaming/service-catalog-backstage', '--format', 'text');

      expect(outcome.exitCode).toBe(1);
      expect(outcome.stdout).toMatch(/\.omd\/now\.yaml: valid against service schema v1\.2\.1/);
      expect(outcome.stdout).toMatch(/\.omd\/backstage-sqs\/now\.yaml: 1 error\(s\) against component schema v1\.3\.0/);
      expect(outcome.stdout).toMatch(/folder name, backstage-sqs, does not align with the specified OMD component name, other/);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  it('accepts the fixture service and component when Backstage agrees', async () => {
    const catalogBody = (url: string): unknown => {
      if (url.includes('jira/teams')) return { CEA: ['CEA O11Y SC Service catalog'] };
      if (url.includes('kind=domain')) return [{ metadata: { name: 'observability' } }];
      return [];
    };
    const service = await check(path.join(repo, '.omd', 'now.yaml'), 'service', '1.2.1', catalogBody);
    const component = await check(path.join(repo, '.omd', 'backstage', 'now.yaml'), 'component', '1.4.5', catalogBody);
    expect(service.valid).toBe(true);
    expect(component.valid).toBe(true);
  });

  it('rejects a Jira team Backstage does not list', async () => {
    const outcome = await check(path.join(repo, '.omd', 'backstage', 'now.yaml'), 'component', '1.4.5', url =>
      url.includes('jira/teams') ? { CEA: ['Some other team'] } : [],
    );
    expect(outcome.valid).toBe(false);
    expect(outcome.errors.map(error => error.message).join('\n')).toMatch(/Jira team/);
  });

  function client(bodyFor: (url: string) => unknown): BackstageClient {
    const fetchImpl: typeof fetch = async input => {
      const body = bodyFor(String(input));
      return new Response(JSON.stringify(body), { status: body === undefined ? 500 : 200 });
    };
    return new BackstageClient({ url: 'https://backstage.test', secret: 'c2VjcmV0', fetch: fetchImpl });
  }

  async function check(file: string, kind: Kind, version: string, fetchBody: (url: string) => unknown) {
    const document = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const loaded = await registry.load(kind, version);
    const ctx = {
      skipBackstage: false,
      repository: 'wbd-streaming/service-catalog-backstage',
      componentNames: ['backstage', 'backstage-aurora', 'backstage-elasticache', 'backstage-sqs'],
      client: client(fetchBody),
    };
    const validate = compileDocument(loaded.schema, ignoredKeywords(document, kind, version, file, false), ctx);
    return validationOutcome(validate, document);
  }
});
