# Administration Guide — VFS Provider for Google Drive

> **Development status:** The current package is a project scaffold. It does
> not connect to Google, publish a usable VFS storage, or provide account
> setup. It is not ready for deployment.

This guide records the administrative boundary of the project while the
provider is under development. Runtime setup, managed deployment, OAuth
registration, and recovery procedures will be added when those functions
exist.

## 1. Intended service scope

The finished add-on is intended to expose a user's Google Drive as a storage
connection to compatible Thunderbird add-ons through the Thunderbird VFS
Toolkit. A consuming add-on will need a user-approved connection before it can
request file or folder operations.

The current build only displays a localized development-status page. It does
not:

- start Google OAuth;
- store account credentials or tokens;
- call Google Drive APIs;
- advertise a VFS provider to other add-ons; or
- grant a consumer access to storage.

## 2. Current platform requirements

- Thunderbird 140 or newer
- an XPI built from this repository

The manifest currently requests only the `storage` permission used by the
vendored VFS provider module for its connection records. The provider is not
initialized in this scaffold, so it does not create those records yet. The
manifest requests no host permissions or Experiment APIs. Future permissions
must match implemented functions and will be documented before a deployable
version is published.

## 3. Build inspection

For an internal review build:

```sh
npm ci
npm run test:review
npm run build
```

The current package is written to
`dist/vfs-provider-googledrive_0_1_0.xpi`. The XPI contains the extension source,
license, vendor record, and project documentation. Development dependencies and
build output are not source inputs.

Run the full Thunderbird linter check before a release candidate is evaluated:

```sh
npm test
```

This command downloads the current Thunderbird WebExtension linter and needs
network access.

## 4. Development-build behavior

After loading the development XPI, the add-on options page reports that Google
Drive account setup and storage access are unavailable. This is the expected
result for version 0.1.0.

No provider should appear in a VFS client and no Google authorization window
should open. Either behavior would differ from the intended scaffold state and
should be reported with the add-on version and Thunderbird version.

## 5. Planned administrative decisions

The following items must be settled and documented before deployment:

- supported Thunderbird release range;
- Google Cloud project and OAuth client registration;
- requested Google scopes and their review status;
- account add, reconnect, revoke, and removal flows;
- consumer connection grants and revocation;
- support for My Drive, shared items, and shared drives;
- organization policy and managed deployment options;
- logging controls, diagnostics, and retention guidance; and
- upgrade, rollback, and account-data migration procedures.

No administrator should create production OAuth credentials from assumptions in
this scaffold.

## 6. Security and support data

The current build holds no Google credentials. When authentication is added,
authorization codes, access tokens, refresh tokens, authorization headers, and
file content must not be written to logs. Diagnostic output should identify an
operation and result without exposing account or file data that is not needed
for support.

Before sharing a future diagnostic log, review it for user identifiers, file
names, folder names, and storage IDs.

## 7. Source and vendor review

The Thunderbird VFS provider and HTML localization modules are packaged from a
fixed `thunderbird/webext-support` revision without local changes. Their source
URLs, licenses, and SHA-256 values are recorded in [VENDOR.md](../VENDOR.md).

Developer architecture, reference projects, and review commands are documented
in [DEVELOPMENT.md](DEVELOPMENT.md).
