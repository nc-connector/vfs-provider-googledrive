# Development Guide — VFS Provider for Google Drive

> **Development status:** Version 0.1.0 is an MV3 foundation only. It does not
> register a working VFS provider, authenticate a Google account, or implement
> Google Drive storage operations.

## 1. Product goal

The project will provide Google Drive storage to compatible Thunderbird add-ons
through Thunderbird's VFS Toolkit. It is a standalone provider with its own
account handling and Google Drive implementation.

The design separates three concerns:

1. Google accounts and credentials owned by this add-on;
2. VFS connections granted to individual consumer add-ons; and
3. request-scoped file and folder operations performed for a granted
   connection.

The scaffold deliberately does not publish a placeholder provider. Discovery
will be added only when account setup, connection grants, and storage access can
form a usable path.

## 2. Technical references

The primary implementation references are fixed to Thunderbird
`webext-support` commit
`3476faa0870bb6dbe63c7c72fc3dab2b67731f4e`:

- [VFS example provider](https://github.com/thunderbird/webext-support/tree/3476faa0870bb6dbe63c7c72fc3dab2b67731f4e/modules/vfs-toolkit/example-vfs-provider)
- [VFS provider API guide](https://github.com/thunderbird/webext-support/blob/3476faa0870bb6dbe63c7c72fc3dab2b67731f4e/modules/vfs-toolkit/vfs-provider/README.md)
- [VFS provider module](https://github.com/thunderbird/webext-support/blob/3476faa0870bb6dbe63c7c72fc3dab2b67731f4e/modules/vfs-toolkit/vfs-provider/vfs-provider.mjs)

The example defines the expected provider lifecycle and connection flow. The
provider guide and module define the supported callback surface, progress,
cancellation, errors, storage-change reports, and per-consumer connection
records.

[jobisoft/vfs-provider-webdav](https://github.com/jobisoft/vfs-provider-webdav/tree/1e5d3beba3b778999cebc74f2d6a2e9508f56bab)
is an additional structural reference for keeping provider accounts separate
from consumer connections. It is not the implementation baseline for Google
Drive, and this project does not include its WebDAV protocol code.

## 3. Repository layout

| Path | Purpose |
|---|---|
| `src/manifest.json` | Thunderbird MV3 manifest and product metadata |
| `src/background.mjs` | module background entry point |
| `src/state/` | versioned account, connection-binding, and preference storage |
| `src/core/logger.mjs` | redacted provider diagnostics |
| `src/options/` | localized development-status page |
| `src/_locales/` | WebExtension messages for all supported locales |
| `src/vendor/vfs-toolkit/` | unmodified Thunderbird VFS provider module |
| `src/vendor/i18n/` | unmodified Thunderbird HTML localization module |
| `tools/build.js` | XPI builder |
| `tools/review-check.js` | source, manifest, locale, vendor, and format checks |
| `tools/package-check.js` | packaged-file allowlist check |
| `tools/webext-linter-*.js` | Thunderbird linter and dependency checks |
| `docs/ADMIN.md` | deployment and operational status |
| `VENDOR.md` | upstream revision, license, source URL, and hash record |

## 4. Manifest V3 rules

- Keep the background entry point as an ES module.
- Register background event listeners during module evaluation.
- Keep account and connection state in extension storage rather than relying on
  module globals surviving a background restart.
- Keep each long-running operation scoped to its VFS request ID.
- Add only documented Thunderbird WebExtension APIs and only permissions used by
  shipped code.
- Do not add Experiment APIs.
- Do not load executable code from a remote location.
- A future `runtime.onMessage` listener must return a promise only for messages
  it handles; it must return `undefined` for unrelated messages.

The manifest currently has a minimum Thunderbird version of 140.0, the
`storage` permission required by the vendored provider module, and no host
permissions. Any change to that set needs a matching implementation and
documentation update.

## 5. Current runtime surface

The scaffold uses only this product-owned background registration:

| API | Use | Permission |
|---|---|---|
| `browser.runtime.onStartup.addListener` | establishes the MV3 startup event boundary | none |

The options page imports the vendored localization helper, which resolves
messages through `browser.i18n.getMessage`. The manifest's `default_locale` is
`de`.

The background imports the vendored VFS module and declares
`GoogleDriveVfsProvider` as its product-owned subclass. It does not construct or
initialize that class, so the scaffold does not register provider listeners or
advertise a storage connection.

The provider module uses `browser.storage.local` for consumer connection
records. This is why the scaffold declares `storage` before Google account
storage is implemented.

## 6. Planned provider boundary

Account records and VFS connection records must remain distinct:

- an account record identifies one authorized Google account and its stored
  authentication state;
- a VFS connection binds one consumer add-on to one account through an opaque
  storage ID; and
- revoking a connection must not silently remove the Google account or grants
  belonging to other consumers.

`ProviderStateRepository` stores only the account binding for a VFS storage ID.
The vendored Toolkit remains the owner of consumer add-on IDs, picker names,
capabilities, and discovery records in `vfs-toolkit-connections`. This avoids a
second copy of Toolkit connection data. Repository account queries omit refresh
tokens unless an internal authorization lookup is explicitly requested.

The repository serializes writes performed by its background instance and uses
a versioned storage record. UI pages must request state changes through the
background instead of constructing independent writers.

Provider preferences use a separate versioned record. The initial export
choices are DOCX for Google Docs, XLSX for Google Sheets, PPTX for Google Slides,
and PDF for Google Drawings. PDF is also an available choice for Docs, Sheets,
and Slides. An OAuth client ID can be supplied for development and managed
deployments until a project-owned production client is selected; OAuth client
IDs are identifiers, not secrets.

Incoming requests must validate the consumer, storage ID, requested capability,
and current account state before accessing Google Drive. Setup data supplied by
a consumer is not an account credential.

Google Drive objects use stable IDs and can have duplicate display names. The
future path layer must retain object identity instead of treating a visible path
as a globally unique key. Decisions for shortcuts, shared items, Google-native
documents, and shared drives must be made before the related callbacks are
implemented.

## 7. Planned VFS operations

The provider API exposes callbacks for:

- listing and storage usage;
- reading and writing files;
- adding folders;
- moving and copying files or folders;
- deleting files or folders; and
- canceling a request.

Capabilities must be declared only after their complete callback path exists.
Long operations need request-scoped progress and cancellation. Partial folder
operations need storage-change reports for items already changed before an
abort or error, as described by the upstream provider guide.

Google API transport, upload strategy, retry policy, quota mapping, change
tracking, and error translation are not part of this scaffold and must not be
inferred from the vendored Toolkit.

### Diagnostic logging

Product logs use the `[GDRVFS]` prefix. The logger accepts only operation names,
phases, counts, byte totals, progress, retry data, HTTP status values, and stable
error codes. It drops tokens, authorization data, names, paths, URLs, account and
storage identifiers, addresses, request bodies, and file content. Error objects
are reduced to their type, stable code, and numeric HTTP status; their free-text
messages are not logged. Debug entries remain disabled until the user enables
the preference.

## 8. Vendor policy

The files below come from Thunderbird `webext-support` commit
`3476faa0870bb6dbe63c7c72fc3dab2b67731f4e` and are packaged without local
changes:

- `src/vendor/vfs-toolkit/vfs-provider.mjs`
- `src/vendor/i18n/i18n.mjs`

Do not patch product behavior into these files. Update a vendor file only by
selecting a new upstream revision, copying the upstream content, and updating
the hashes and source links in [VENDOR.md](../VENDOR.md). The review check rejects
content that differs from the recorded hashes.

## 9. Localization

Every user-visible string belongs in `src/_locales/**/messages.json`. German is
the default locale, and each English key must exist in all 15 supported locale
folders. The locale list and update steps are recorded in
[Translations.md](../Translations.md).

## 10. Build and review

Use Node.js 22 or newer.

```sh
npm ci
npm run test:review
```

`test:review` checks the source tree, builds `.tmp/review.xpi`, compares the XPI
contents with the package allowlist, and removes the temporary package after a
successful check.

Create the normal build with:

```sh
npm run build
```

Run the complete check set before a release candidate or review handoff:

```sh
npm test
```

The full check downloads the current Thunderbird WebExtension linter, audits
the selected linter dependencies, and runs it against the extension source.

## 11. Change checklist

Before committing a functional provider change:

1. Check the callback and data shapes against the fixed upstream provider API.
2. Add only the manifest permissions used by that change.
3. Add localized text to every supported locale.
4. Keep secrets, authorization data, and file content out of logs.
5. Cover success, error, cancellation, and background-restart behavior where
   the change applies.
6. Update `README.md`, `docs/ADMIN.md`, `docs/DEVELOPMENT.md`, `Translations.md`,
   or `VENDOR.md` when their statements change.
7. Run `npm run test:review` and `npm test`.

## 12. Items not yet defined

The following choices remain open and must be resolved before their code is
added:

- Google OAuth client ownership and redirect configuration;
- Google authorization scopes;
- supported drive types and Google-native files;
- retry, upload-resume, timeout, and rate-limit behavior;
- account and connection migration rules;
- storage-change polling or Google change-token strategy; and
- release signing, update channel, and managed deployment.
