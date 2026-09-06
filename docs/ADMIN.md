# Administration Guide — VFS Provider for Google Drive

> **Development status:** The current package includes the internal OAuth
> account service but no account setup UI or usable VFS storage. It is not ready
> for deployment.

This guide records the administrative boundary of the project while the
provider is under development. Runtime setup, managed deployment, OAuth
registration, and recovery procedures will be added when those functions
exist.

## 1. Intended service scope

The finished add-on is intended to expose a user's Google Drive as a storage
connection to compatible Thunderbird add-ons through the Thunderbird VFS
Toolkit. A consuming add-on will need a user-approved connection before it can
request file or folder operations.

The current build only displays a localized development-status page. Its OAuth
service has no user-facing entry point yet. It does not:

- start Google OAuth during normal use;
- call Google Drive APIs;
- advertise a VFS provider to other add-ons; or
- grant a consumer access to storage.

## 2. Current platform requirements

- Thunderbird 140 or newer
- an XPI built from this repository

The manifest requests `storage` and `identity`. Host access is limited to
Google's OAuth token/revocation endpoint and Google Drive API endpoint. It does
not request access to arbitrary sites or include Experiment APIs. The provider
is not initialized yet, so it does not advertise VFS connections.

## 3. Google Cloud development setup

Live OAuth testing needs a separate Google Cloud project with the Google Drive
API enabled, an OAuth consent screen, and a Desktop app OAuth client. Enter that
client ID in provider preferences when the account UI becomes available. Do not
place a client secret in this repository or the XPI; a desktop client is public
and the implementation uses PKCE.

The requested full Drive scope is restricted. A production release needs a
project-owned client, public privacy and support information, and Google's
app-verification process. A Google Cloud project left in external testing mode
is suitable only for listed testers and its refresh grants can expire after
seven days.

## 4. Build inspection

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

## 5. Development-build behavior

After loading the development XPI, the add-on options page reports that Google
Drive account setup and storage access are unavailable. This is the expected
result for version 0.1.0.

No provider should appear in a VFS client and no Google authorization window
should open. Either behavior would differ from the intended scaffold state and
should be reported with the add-on version and Thunderbird version.

## 6. Planned administrative decisions

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

## 7. Security and support data

The OAuth service stores refresh tokens in the Thunderbird profile through
`storage.local` and access tokens in `storage.session`. Thunderbird does not
document either location as an operating-system credential vault. Protecting
the Thunderbird profile and device is therefore part of credential protection.
Authorization codes, access tokens, refresh tokens, authorization headers, and
file content are excluded from product logs. Diagnostic output identifies an
operation and result without exposing account or file data that is not needed
for support.

Before sharing a future diagnostic log, review it for user identifiers, file
names, folder names, and storage IDs.

## 8. Source and vendor review

The Thunderbird VFS provider and HTML localization modules are packaged from a
fixed `thunderbird/webext-support` revision without local changes. Their source
URLs, licenses, and SHA-256 values are recorded in [VENDOR.md](../VENDOR.md).

Developer architecture, reference projects, and review commands are documented
in [DEVELOPMENT.md](DEVELOPMENT.md).
