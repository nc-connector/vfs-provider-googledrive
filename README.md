# VFS Provider for Google Drive

> **Development status:** This repository currently contains an initial
> Manifest V3 project scaffold. It does not authenticate with Google, expose a
> discoverable VFS storage, or read and write Google Drive content. Do not use
> this build in production.

VFS Provider for Google Drive is intended to make Google Drive storage
available to compatible Thunderbird add-ons through Thunderbird's VFS Toolkit.
The provider is developed as a separate add-on and does not depend on NC
Connector at runtime.

## Current scope

The initial scaffold provides:

- a Thunderbird Manifest V3 extension with a module background;
- a localized status page;
- the unmodified Thunderbird VFS provider and i18n modules at a fixed upstream
  revision;
- a reproducible XPI build script;
- local package and review checks; and
- administrator and developer documentation.

Google OAuth, account management, VFS connection grants, Google Drive API
operations, progress, cancellation, and storage-change reporting are not yet
implemented.

## Requirements

- Node.js 22 or newer
- npm
- Thunderbird 140 or newer for development installation and testing

## Build and test

Install the recorded development dependencies:

```sh
npm ci
```

Create the XPI:

```sh
npm run build
```

The package is written to `dist/vfs-provider-googledrive_0_1_0.xpi` for the
current version.

Run the local source and package checks:

```sh
npm run test:review
```

Run the complete check set, including a fresh copy of Thunderbird's current
WebExtension linter:

```sh
npm test
```

The complete check requires network access because it downloads the linter from
the Thunderbird `webext-linter` repository.

## Documentation

- [Administration guide](docs/ADMIN.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Translations](Translations.md)
- [Vendored source record](VENDOR.md)

## Technical baseline

The primary VFS references are Thunderbird's
[example provider](https://github.com/thunderbird/webext-support/tree/3476faa0870bb6dbe63c7c72fc3dab2b67731f4e/modules/vfs-toolkit/example-vfs-provider)
and
[provider API documentation](https://github.com/thunderbird/webext-support/blob/3476faa0870bb6dbe63c7c72fc3dab2b67731f4e/modules/vfs-toolkit/vfs-provider/README.md).
The project also studies
[jobisoft/vfs-provider-webdav](https://github.com/jobisoft/vfs-provider-webdav/tree/1e5d3beba3b778999cebc74f2d6a2e9508f56bab)
as an additional reference for separating provider accounts from consumer
connections. Google Drive access will use its own implementation; WebDAV
protocol code is not part of this scaffold.

See [VENDOR.md](VENDOR.md) for the fixed Thunderbird revision, source links,
licenses, and file hashes.

## License

This project is licensed under the Mozilla Public License 2.0. See
[LICENSE](LICENSE).
