# Development Guide — VFS Provider for Google Drive

> **Development status:** Version 0.1.0 includes the MV3 foundation, Google
> OAuth account services, localized account and connection settings, and a
> working read-only VFS provider. Write operations and release validation are
> still in progress.

## 1. Product goal

The project will provide Google Drive storage to compatible Thunderbird add-ons
through Thunderbird's VFS Toolkit. It is a standalone provider with its own
account handling and Google Drive implementation.

The design separates three concerns:

1. Google accounts and credentials owned by this add-on;
2. VFS connections granted to individual consumer add-ons; and
3. request-scoped file and folder operations performed for a granted
   connection.

The provider publishes only capabilities backed by a complete account,
connection, and Drive access path.

## 2. Technical references

The VFS provider references are fixed to the review revision from
[`thunderbird/webext-support#96`](https://github.com/thunderbird/webext-support/pull/96),
commit `a82f2b767f4183f582ed33e81cd35a1c45639430`:

- [VFS example provider](https://github.com/thunderbird/webext-support/tree/a82f2b767f4183f582ed33e81cd35a1c45639430/modules/vfs-toolkit/example-vfs-provider)
- [VFS provider API guide](https://github.com/thunderbird/webext-support/blob/a82f2b767f4183f582ed33e81cd35a1c45639430/modules/vfs-toolkit/vfs-provider/README.md)
- [VFS provider module](https://github.com/thunderbird/webext-support/blob/a82f2b767f4183f582ed33e81cd35a1c45639430/modules/vfs-toolkit/vfs-provider/vfs-provider.mjs)

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
| `src/background.js` | module background entry point |
| `src/state/` | versioned account, connection-binding, and preference storage |
| `src/core/logger.mjs` | redacted provider diagnostics |
| `src/google/` | Google OAuth, session-token, and Drive API services |
| `src/provider/` | VFS adapter and account-bound connection lifecycle |
| `src/runtime/` | internal extension message boundary |
| `src/options/` | localized account and provider settings |
| `src/connection/` | localized VFS setup and configuration popups |
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
- Name scripts loaded directly by the manifest or an HTML page with `.js`.
  Name reusable imported modules and vendored modules with `.mjs`. Node build
  and review tools use CommonJS `.js`; tests use ESM `.mjs`.
- Register background event listeners during module evaluation.
- Keep account and connection state in extension storage rather than relying on
  module globals surviving a background restart.
- Keep each long-running operation scoped to its VFS request ID.
- Add only documented Thunderbird WebExtension APIs and only permissions used by
  shipped code.
- Do not add Experiment APIs.
- Do not load executable code from a remote location.
- The `runtime.onMessage` listener must return a promise only for messages
  it handles; it must return `undefined` for unrelated messages.

The manifest currently has a minimum Thunderbird version of 140.0. It requests
`storage` for Toolkit, account, preference, and session state, plus `identity`
for the interactive OAuth window. Host access is limited to
`oauth2.googleapis.com` for token exchange/revocation and `www.googleapis.com`
for Drive API calls. The authorization page at `accounts.google.com` is opened
by `identity.launchWebAuthFlow()` and does not need host access.

## 5. Current runtime surface

The product-owned background registers these event boundaries during module
evaluation:

| API | Use | Permission |
|---|---|---|
| `browser.runtime.onMessage.addListener` | internal account and preference requests | none |
| `browser.runtime.onStartup.addListener` | resumes the MV3 startup boundary | none |
| `browser.storage.onChanged.addListener` | applies debug changes and reconciles removed VFS connections | `storage` |
| `browser.runtime.onMessageExternal.addListener` | VFS provider discovery | none |
| `browser.runtime.onConnectExternal.addListener` | consumer-bound VFS requests | none |
| `browser.windows.onRemoved.addListener` | cancels abandoned setup requests | none |

The options page imports the vendored localization helper, which resolves
messages through `browser.i18n.getMessage`. Its `.js` entry point delegates
message and view state to a DOM-independent `.mjs` controller. The manifest's
`default_locale` is `de`.

The background constructs the account, preference, OAuth-session, OAuth-client,
connection, Drive transport, and logger services before it accepts work. The
runtime message listener is not declared `async`: it returns a promise for known
internal messages and `undefined` for all other messages. The background
constructs `GoogleDriveVfsProvider` and calls its synchronous `init()` during
module evaluation. Provider operations wait for asynchronous repository
initialization through the shared readiness promise.

The provider module uses `browser.storage.local` for consumer connection
records. Product account records and preferences use separate keys in the same
storage area; access tokens and active PKCE data use `browser.storage.session`.

### OAuth account flow

The account service uses Google's Authorization Code flow with PKCE and the
documented Thunderbird `identity` API. It derives Mozilla's Google-compatible
loopback redirect from the fixed add-on ID:

```text
http://127.0.0.1/mozoauth2/<extension-id-hash>
```

The Google Cloud credential must be a Desktop app client. Public installed
clients do not use a client secret. A 32-byte random verifier and independent
state value are held in `storage.session` for the authorization transaction.
The returned state and redirect are checked before the code is exchanged.

The provider requests `https://www.googleapis.com/auth/drive`. The narrower
`drive.file` scope cannot represent an existing Drive tree because it only sees
files created by or explicitly opened for the app. The full scope is restricted
and a published build needs the corresponding Google verification work.

Refresh tokens and minimal Google account metadata are stored in
`storage.local`; normal account queries omit the refresh token. Access tokens
and PKCE transactions are stored in `storage.session` and are replaced on
expiry. Thunderbird does not expose a documented operating-system credential
store to ordinary WebExtensions, so the project does not describe local token
storage as encrypted. Profile access must be treated as credential access.

Token refresh is deduplicated per account. `invalid_grant` marks that account as
requiring authorization again. Disconnect first asks Google to revoke the
refresh token, then removes local credentials even if revocation fails. The
settings page reports when the account was removed locally but its Google grant
may remain. An interactive authorization window is opened only for an internal
user action, never during startup.

The options page saves provider preferences before it starts a new login. A
reauthorization request includes the selected local account ID, uses that
account's original OAuth client ID and login hint, and rejects a returned Google
identity that does not match. The page renders account data as text and never
receives refresh or access tokens.

### Drive request layer

`GoogleDriveTransport` obtains access tokens from the account service and adds
the authorization header inside the background context. A 401 response causes
one forced token refresh. Safe read requests use bounded exponential backoff
with jitter for network failures, HTTP 429, HTTP 5xx, and Drive's documented
rate-limit reasons. Requests that may mutate data are not repeated after an
unknown network outcome unless a future caller explicitly selects that mode.
If `Retry-After` exceeds the in-memory wait budget, the transport returns a
typed deferred-retry error instead of retrying early or keeping an MV3
background wait alive for an unbounded period.

The same transport accepts only Google's Drive API path, Drive upload path, or
a resumable-session URL below the validated Drive upload path. A raw response
mode preserves the `Location`, HTTP 308, and `Range` values needed by the future
resumable uploader. It does not make upload decisions or repeat a mutating
request after an unknown result.

`GoogleDriveApiClient` provides paginated file and shared-drive
listing, metadata, storage quota, binary download, byte ranges, and Google
Workspace export. File and account identifiers, query text, paths, and request
URLs are excluded from diagnostic records. The provider creates the Drive
namespace only after the Toolkit connection, requested read capability, local
account binding, and current account status have been checked.

## 6. Provider boundary

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
read path retains object identity in encoded path segments rather than treating
a visible name as a globally unique key. It resolves shortcuts, distinguishes
duplicate siblings, exports supported Google-native documents, and separates
My Drive, shared items, and Shared drives into virtual roots.

## 7. VFS operations

The provider API exposes callbacks for:

- listing and storage usage;
- reading and writing files;
- adding folders;
- moving and copying files or folders;
- deleting files or folders; and
- canceling a request.

The current provider advertises folder read and file read. It implements root
and folder listing, storage quota, binary download, Workspace export, localized
VFS errors, and request-scoped cancellation. The account binding and capability
are checked for every operation.

Capabilities for writes remain disabled until their complete callback paths
exist. Uploads and other long write operations need request-scoped progress and
cancellation. Partial folder operations need storage-change reports for items
already changed before an abort or error, as described by the upstream provider
guide. Upload strategy and change tracking remain product-owned work and must
not be inferred from the vendored Toolkit.

### Diagnostic logging

Product logs use the `[GDRVFS]` prefix. The logger accepts only operation names,
phases, counts, byte totals, progress, retry data, HTTP status values, and stable
error codes. It drops tokens, authorization data, names, paths, URLs, account and
storage identifiers, addresses, request bodies, and file content. Error objects
are reduced to their type, stable code, and numeric HTTP status; their free-text
messages are not logged. Debug entries remain disabled until the user enables
the preference.

## 8. Vendor policy

The files below come from fixed Thunderbird `webext-support` revisions and are
packaged without local changes:

- `src/vendor/vfs-toolkit/vfs-provider.mjs`
- `src/vendor/i18n/i18n.mjs`

Their individual revisions and hashes are recorded in
[VENDOR.md](../VENDOR.md).

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

## 12. Pending release inputs

The implementation still needs these inputs or later release decisions:

- a project-owned production Google OAuth Desktop client ID;
- the final product icon and Google brand review;
- the oldest Thunderbird version verified by smoke testing;
- upload-resume and write timeout behavior;
- account and connection migration rules;
- storage-change polling or Google change-token strategy; and
- release signing, update channel, and managed deployment.
