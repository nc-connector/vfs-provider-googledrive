# VFS Provider for Google Drive™

<p align="center">
  <img src="src/assets/icon-128.png" width="128" height="128" alt="VFS Provider for Google Drive app icon">
</p>

<p align="center">
  <img src="docs/assets/google-drive-logo.png" width="32" height="32" alt="Google Drive logo"><br>
  Integrates with Google Drive™
</p>

> **Development status:** This repository contains a working VFS provider for
> Google Drive. Consumer add-ons can create an account-bound connection, browse
> and read Drive content, upload or replace files, create folders, move, copy,
> and merge items, move items to the Google Drive trash, and receive remote
> change updates. Release validation is not complete, so this build is not ready
> for production.

VFS Provider for Google Drive is intended to make Google Drive storage
available to compatible Thunderbird add-ons through Thunderbird's VFS Toolkit.
The provider is developed as a separate add-on and does not depend on NC
Connector at runtime.

## Current scope

The current build provides:

- a Thunderbird Manifest V3 extension with a module background;
- localized account, consumer-access, and provider settings;
- a versioned state repository that keeps Google accounts separate from VFS
  consumer connections;
- versioned OAuth configuration with a packaged default, an optional local
  Google Desktop client, and administrator-locked Thunderbird managed policy;
- versioned preferences for diagnostics and Google Workspace export formats;
- privacy-aware diagnostic logging with a strict metadata allowlist;
- Google OAuth Authorization Code flow with PKCE, token refresh, revocation,
  and restart-safe session token storage;
- localized OAuth client, account, diagnostic, and Google Workspace export
  settings;
- authenticated Google Drive v3 requests with token refresh, bounded retry and
  request deadlines, validated upload-session URLs, pagination, quota,
  metadata, download, and export helpers;
- a consumer-bound VFS connection lifecycle with localized setup and
  configuration popups;
- VFS access to My Drive, Shared with me, and Shared drives, including Google
  Workspace export, shortcuts, duplicate names, new file and folder creation,
  binary file replacement, file and folder moves and copies, folder merges,
  removal to the Google Drive trash, request progress and cancellation, and
  storage quota reporting;
- MV3 alarm-based polling of user and Shared Drive change logs with persistent
  cursors and per-connection storage refresh reports;
- the unmodified Thunderbird VFS provider and i18n modules at a fixed upstream
  revision;
- a reproducible XPI build script;
- local package and review checks; and
- administrator and developer documentation.

The provider advertises file/folder read, add, modify, and delete capabilities.
New and replacement files use a multipart upload through 5 MB and a resumable
upload above that limit. Ordinary moves change Drive metadata without
downloading file content. Replaced move targets and emptied source folders from
a merge are moved to the Google Drive trash, as are items deleted through VFS;
the provider never permanently deletes content. File copies use Drive's
server-side copy operation. Folder copies create the destination folders and
copy their files within Drive without downloading their content. If a
multi-step move or copy stops after changing some entries, connected clients
receive a change report for the affected destination. Existing consumer
connections receive the current capability set during startup. Remote Drive
changes are checked every five minutes for connected accounts. A changed Drive
invalidates the VFS storage root so an open picker can refresh its current
folder without relying on unstable Drive paths.
The settings page lists every current consumer connection and can revoke one
add-on's access without removing the Google account or Drive files. Release
packages include the project's Google Desktop OAuth client as the default. An
unmanaged profile can instead use its own Google Desktop client, and an
administrator can force either the built-in or a custom client through
Thunderbird managed storage. Selecting a client never authorizes a Google
account by itself; each account still requires an explicit user sign-in and
consent.

## Requirements

- Node.js 22 or newer
- npm
- Thunderbird 140 or newer for development installation and testing

## Build and test

Install the recorded development dependencies:

```sh
npm ci
```

Create the XPI from the publisher's Google Desktop credential JSON, which must
remain outside the project folder and source control:

```powershell
$env:GDRVFS_OAUTH_CREDENTIALS_FILE = "C:\external\path\client_secret.json"
npm run build
Remove-Item Env:\GDRVFS_OAUTH_CREDENTIALS_FILE
```

The package is written to `dist/vfs-provider-googledrive_0_1_0.xpi` for the
current version. The credential JSON is read as build input; it is neither
copied into the package nor logged. Its client ID and client secret are inserted
only into the packaged OAuth module. The distributed XPI necessarily exposes
these public installed-application client values. The built-in client remains
the product default and the target of a managed `builtin` policy, so a normal
release build still requires this input even though a user or administrator can
select a custom client after installation.

Run the local source and package checks:

```sh
npm run test:review
```

Run the complete check set, including a fresh copy of Thunderbird's current
WebExtension linter:

```sh
npm test
```

The review build uses synthetic OAuth values and needs no publisher credential.
The complete check requires network access because it downloads the linter from
the Thunderbird `webext-linter` repository.

## Documentation

- [Changelog](CHANGELOG.md)
- [Privacy policy](PRIVACY.md)
- [Administration guide](docs/ADMIN.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Translations](Translations.md)
- [Vendored source record](VENDOR.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Technical baseline

The primary VFS references are Thunderbird's
[example provider](https://github.com/thunderbird/webext-support/tree/a82f2b767f4183f582ed33e81cd35a1c45639430/modules/vfs-toolkit/example-vfs-provider)
and
[provider API documentation](https://github.com/thunderbird/webext-support/blob/a82f2b767f4183f582ed33e81cd35a1c45639430/modules/vfs-toolkit/vfs-provider/README.md).
The project also studies
[jobisoft/vfs-provider-webdav](https://github.com/jobisoft/vfs-provider-webdav/tree/1e5d3beba3b778999cebc74f2d6a2e9508f56bab)
as an additional reference for separating provider accounts from consumer
connections. Google Drive access uses its own implementation; WebDAV protocol
code is not part of this provider.

See [VENDOR.md](VENDOR.md) for the fixed Thunderbird revision, source links,
licenses, and file hashes.

## License

This project is licensed under the Mozilla Public License 2.0. See
[LICENSE](LICENSE). Notices for packaged third-party source are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This independent project is not affiliated with, endorsed by, or sponsored by
Google. Google Drive is a trademark of Google Inc. Use of this trademark is
subject to Google Permissions.
