# Administration Guide — VFS Provider for Google Drive

> **Development status:** The current package provides Google Drive storage
> through VFS, including account-bound setup, browsing, reading, new file
> uploads and replacement, folder creation, file and folder moves, folder
> copies and merges, and removal to the Google Drive trash. It is not ready for
> production deployment because release validation is incomplete.

This guide records the current setup and administrative boundary of the
project while the provider is under development. Decisions that still depend
on release infrastructure or policy are listed separately.

## 1. Intended service scope

The finished add-on is intended to expose a user's Google Drive as a storage
connection to compatible Thunderbird add-ons through the Thunderbird VFS
Toolkit. A consuming add-on will need a user-approved connection before it can
request file or folder operations.

The current build provides a localized settings page where a tester can enter a
Desktop OAuth client ID, add or reauthorize Google accounts, remove an unused
account, choose Workspace export formats, and enable diagnostic logging. A
compatible VFS consumer can create a connection for one account, rename that
connection, switch its account, browse and read Drive content, upload new files,
replace binary files, create folders, move or copy files and folders, merge
folders, and move files or folders to the Google Drive trash. Move, copy, and
merge requests follow the permissions and cross-drive restrictions reported by
Google Drive. Replaced targets and source folders emptied by a merge are placed
in the recoverable Drive trash. The provider does not permanently delete
content. Previously granted connections receive the current add, modify, and
delete capabilities when the provider starts. Remote Drive changes are checked
every five minutes for accounts with a current VFS connection. A detected
change causes the corresponding consumer storage to refresh. It does not yet:

- list and revoke individual consumer connections in the provider settings.

## 2. Current platform requirements

- Thunderbird 140 or newer
- an XPI built from this repository

The manifest requests `alarms`, `storage`, and `identity`. The alarm wakes the
MV3 background for periodic Drive change checks. Host access is limited to
Google's OAuth token/revocation endpoint and Google Drive API endpoint. It does
not request access to arbitrary sites or include Experiment APIs. The provider
registers during background startup and advertises only connections previously
approved by the user for the requesting consumer add-on.

## 3. Google Cloud and account setup

### 3.1 Create a development project

Use a separate Google Cloud project for development and live tests:

1. Create or select the development project in Google Cloud Console.
2. Enable the Google Drive API in the project's API library.
3. Configure the Google Auth Platform branding and audience. An Internal
   audience is limited to the project's Google Workspace organization. For an
   External audience in Testing status, add every tester explicitly.
4. Add `https://www.googleapis.com/auth/drive` to the project's requested data
   access scopes.
5. Create an OAuth client with application type **Desktop app**.
6. Copy the client ID ending in `.apps.googleusercontent.com`.

Do not place a client secret in this repository, an XPI, or provider settings.
An installed desktop client cannot keep a shared secret; this implementation
uses PKCE and the Mozilla loopback callback returned through
`browser.identity`.

Google limits an External project in Testing status to its listed test users.
For scopes beyond basic identity, those authorizations and their refresh tokens
normally expire after seven days. That mode is therefore suitable for
development, not a public release.

Official setup references:

- [OAuth 2.0 for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google OAuth test audiences](https://support.google.com/cloud/answer/15549945)

### 3.2 Configure the provider

1. Build and install the development XPI.
2. Open the add-on settings.
3. Enter the Desktop app client ID and save the provider settings.
4. Select **Add account**, complete the Google consent flow, and confirm that
   the expected account appears as connected.
5. Repeat the account step for each Google account that should be available to
   VFS consumers.
6. In a compatible VFS consumer, create a new provider connection, choose one
   connected account, review the requesting add-on name and ID, and grant the
   requested access.

Changing the client ID preference affects new authorizations. Existing account
records retain the client ID that created their grant so token refresh and
reauthorization continue against the matching Google project.

### 3.3 Scope and verification boundary

The provider requests the full Drive scope because a filesystem-style VFS
connection must browse and manage an existing Drive tree. The narrower
`drive.file` scope covers files created by the application or explicitly opened
for it and cannot expose an existing arbitrary tree to connected VFS clients.

Google classifies the full Drive scope as restricted. Before a public release,
the project owner must complete the applicable Google verification work and
provide the required homepage, privacy, support, scope justification, and test
instructions. Whether an additional security assessment applies depends on the
final production data handling and must be confirmed with Google's current
requirements. Development and production should use separate Cloud projects.

### 3.4 Shared Drives

Shared Drives are available only when the selected account belongs to a Google
Workspace edition that provides them and the account is a member of the drive.
They appear below the provider's **Shared drives** root. The provider uses
Drive-specific queries and `supportsAllDrives` handling; it does not grant
membership or raise the user's role. Every read or mutation remains limited by
the permissions Google returns for that account.

Moving folders across drive boundaries is not generally supported by Google.
The provider rejects such moves rather than simulating them with a download and
upload. File copies use Google's server-side copy operation where allowed.

See [Google's Shared Drive API guide](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives)
for the underlying account, query, and permission rules.

### 3.5 Google Workspace exports

Google Docs, Sheets, Slides, and Drawings do not have downloadable native file
content. The provider exports them when a VFS client reads the file. Settings
apply across the provider accounts:

| Google file | Available format | Initial choice |
| --- | --- | --- |
| Docs | DOCX or PDF | DOCX |
| Sheets | XLSX or PDF | XLSX |
| Slides | PPTX or PDF | PPTX |
| Drawings | PDF | PDF |

The chosen extension is shown in the VFS tree and used for the downloaded
file. Export does not alter the original Google Workspace file.

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

After loading the development XPI, the add-on options page can store the Desktop
OAuth client ID and start Google authorization only after the tester presses
the add-account or sign-in-again button. The page discloses the requested Drive
access before that action. A compatible VFS client discovers the provider and
opens the provider-owned setup popup when the user adds a connection. The popup
shows both the consumer name and its add-on ID before an account is granted.

A Google authorization window must not open during installation, startup, or
simply opening the settings. An account cannot be removed while a current VFS
connection still uses it; remove the connection from the consumer first.

Use **Sign in again** when Google rejects a stored grant or the account is
marked for reauthorization. Removing an unused account asks Google to revoke
its grant and then removes the local credentials. If Google cannot be reached,
the local account is still removed and the settings page reports that remote
revocation could not be confirmed. A user can also revoke access from their
Google Account; the provider will then require authorization again.

## 6. Planned administrative decisions

The following items must be settled and documented before deployment:

- supported Thunderbird release range;
- Google Cloud project and OAuth client registration;
- requested Google scopes and their review status;
- production account recovery and administrative revocation procedures;
- provider-side display and revocation of individual consumer connections;
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
The license attributions shipped with the XPI are collected in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

Developer architecture, reference projects, and review commands are documented
in [DEVELOPMENT.md](DEVELOPMENT.md).
