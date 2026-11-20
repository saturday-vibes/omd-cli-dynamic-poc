# omd-cli-dynamic-poc

Proof of concept for an OMD CLI that doesn't depend on any schema package.
Versions are listed from the npm registry and each one is downloaded the first
time it's used. Compare with [omd-cli-poc](https://github.com/saturday-vibes/omd-cli-poc),
which installs every version through aliases in its `package.json`.

Schemas come from [omd-schema-sandbox](https://github.com/saturday-vibes/omd-schema-sandbox),
published as `@test-org-th/omd-schema-component` and `@test-org-th/omd-schema-service`.

```
yarn install && yarn build
node dist/bin/omd.js schema versions
node dist/bin/omd.js schema show --kind service                    # latest
node dist/bin/omd.js schema show --kind component --version v1.4.4
```

## How it works

`src/registry.ts`:

- versions: `npm view <package> versions --json`, X.Y.Z only, newest first
- a version: `npm install <package>@<version> --prefix <tmp> --ignore-scripts
  --no-save`, then moved into `~/.omd-cli/schemas/<kind>/<version>/`
  (`OMD_CACHE_DIR` to change it). Later runs read the cache and don't call npm.

npm runs from the current folder, so the user's `.npmrc` decides the registry
and auth. The CLI holds no credentials. A version that isn't published exits 2.

A new schema release is usable as soon as it's on the registry; the CLI needs
no change or release.
