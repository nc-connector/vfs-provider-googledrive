# Development Guide — VFS Provider for Google Drive

> **Development status:** Version 0.1.0 includes the MV3 foundation, Google
> OAuth account services, localized account and connection settings, and a
> working VFS provider for browsing, reading, creating and replacing files,
> creating folders, moving, copying, and merging items, and moving items to the
> Google Drive trash. Release validation is still in progress.

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
| `src/state/` | versioned account, connection-binding, change-cursor, and preference storage |
| `src/core/` | request cancellation, network deadlines, and redacted provider diagnostics |
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
| `docs/TESTING.md` | automated and live release test matrix |
| `docs/RELEASE.md` | candidate and ATN submission checklist |
| `PRIVACY.md` | add-on data handling and user-control policy |
| `VENDOR.md` | upstream revision, license, source URL, and hash record |
| `THIRD_PARTY_NOTICES.md` | packaged third-party attributions and license notices |

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

The supported range starts at Thunderbird 140.0 and has no upper bound in the
manifest. The add-on uses only documented WebExtension APIs and no Experiment
API, so it does not set `strict_max_version`. Release testing covers the latest
maintenance release of the 140 ESR line and the current ESR at candidate time.

The compatibility floor was checked against the Mozilla and Thunderbird API
documentation. Manifest V3 event pages are supported from Thunderbird 128,
`storage.session` from Thunderbird 115, and the runtime, window, identity, i18n,
and alarm calls used here predate Thunderbird 140. `AbortSignal.any()`, which
combines VFS cancellation with request deadlines, is available from Gecko 124.
The project does not claim support for Thunderbird 128 because its release and
manual test baseline starts at 140.

Version references: Thunderbird's [Manifest V3 migration guide](https://webextension-api.thunderbird.net/en/mv3/guides/manifestV3.html),
[storage](https://webextension-api.thunderbird.net/en/esr-mv3/storage.html),
[runtime](https://webextension-api.thunderbird.net/en/esr-mv3/runtime.html),
[windows](https://webextension-api.thunderbird.net/en/esr-mv3/windows.html),
[identity](https://webextension-api.thunderbird.net/en/esr-mv3/identity.html),
[alarms](https://webextension-api.thunderbird.net/en/esr-mv3/alarms.html), and
[i18n](https://webextension-api.thunderbird.net/en/esr-mv3/i18n.html) API pages,
plus Mozilla's [`AbortSignal.any()` reference](https://developer.mozilla.org/docs/Web/API/AbortSignal/any_static).

The manifest requests `storage` for Toolkit, account, preference, and session
state, `identity` for the interactive OAuth window, and `alarms` for periodic
Drive change checks.
Host access is limited to
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
| `browser.alarms.onAlarm.addListener` | polls Google Drive change logs every five minutes | `alarms` |
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

`ChangePollScheduler` registers its alarm listener during module evaluation.
It keeps a matching periodic alarm instead of replacing it on every event-page
wake, recreates a missing alarm after a full browser restart, and coalesces
overlapping alarm events. A newly created alarm also starts one immediate poll
after repository initialization. VFS connection changes request another poll
after the account bindings have been reconciled.

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

Token exchange, token refresh, profile lookup, and revocation requests have a
30-second deadline. A deadline failure does not mark a connected account for
reauthorization because it says nothing about the validity of the stored grant.
It is reported as a network failure and can be retried by the user or a later
VFS request.

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
unknown network outcome. Their initiation may be repeated only after an
explicit HTTP 429 response or a 403 response carrying a documented rate-limit
reason; a rejected 401 may also be repeated once after token refresh.
If `Retry-After` exceeds the in-memory wait budget, the transport returns a
typed deferred-retry error instead of retrying early or keeping an MV3
background wait alive for an unbounded period.

The same transport accepts only Google's Drive API path, Drive upload path, or
a resumable-session URL below the validated Drive upload path. A raw response
mode preserves the `Location`, HTTP 308, and `Range` values used by the
resumable uploader. It does not make upload decisions or repeat a mutating
request after an unknown result.

Each Drive fetch has a five-minute deadline until response headers arrive. For
writes, that interval includes sending the multipart body or one resumable
8 MiB chunk. A timed-out safe read may use the normal bounded retry path. A
timed-out multipart or metadata mutation is not replayed because its server
outcome is unknown. After a resumable chunk timeout, the uploader queries the
server-confirmed offset before sending more bytes. The deadline is removed once
response headers arrive, so it does not impose a fixed total duration on a
large file download. The VFS request's cancellation signal remains connected
while the response body is read.

`GoogleDriveApiClient` provides paginated file and shared-drive listing,
metadata, storage quota, binary download, byte ranges, Google Workspace export,
and the user and Shared Drive change logs. Change-log reads follow every page
and return the next start token only after the final page. It also provides
metadata-first multipart uploads and the resumable session primitives used by
`GoogleDriveUploader`. Files of 5 MB or less use multipart upload. Larger files
use 8 MiB chunks, whose size is a multiple of Drive's required 256 KiB unit.
Progress advances only to the byte offset confirmed by Drive. After an unknown
chunk result, the uploader queries the session before sending more data; it
never blindly repeats that chunk. A session rejected by Drive can be restarted
once during the active request. Resource keys for link-shared files and parent
folders are included in multipart requests and resumable-session creation,
including a restarted session.

Upload state, source bytes, session URLs, and abort controllers remain bound to
the active VFS request and are not presented as surviving an MV3 background
restart. File and account identifiers, query text, paths, session URLs, and
request URLs are excluded from diagnostic records. The provider creates the
Drive namespace only after the Toolkit connection, requested capability, local
account binding, and current account status have been checked.

After a background reconstruction, a valid session token is reused or a new
access token is obtained from the refresh grant stored with the account.
Connection reconciliation removes a product binding if setup stopped before
the Toolkit stored its matching connection, while a completed Toolkit record
keeps its account binding. Active request controllers and resumable session URLs
are deliberately not restored. A client whose active transfer was interrupted
must start a new VFS request; the provider does not claim that an unknown
in-flight mutation completed.

## 6. Provider boundary

Account records and VFS connection records must remain distinct:

- an account record identifies one authorized Google account and its stored
  authentication state;
- a VFS connection binds one consumer add-on to one account through an opaque
  storage ID; and
- revoking a connection must not silently remove the Google account or grants
  belonging to other consumers.

`ProviderStateRepository` stores the account binding for a VFS storage ID and
per-account change cursors for the user log and individual Shared Drive logs.
The vendored Toolkit remains the owner of consumer add-on IDs, picker names,
capabilities, and discovery records in `vfs-toolkit-connections`. This avoids a
second copy of Toolkit connection data. Repository account queries omit refresh
tokens unless an internal authorization lookup is explicitly requested.

Provider state version 2 adds the change-cursor collection. Version 1 records
are migrated by retaining their accounts and connection bindings and starting
with an empty cursor collection. Removing an account also removes all of its
change cursors in the same state write.

Provider-state upgrades follow these rules:

- each stored schema version has an explicit migration to the next supported
  version;
- a migration retains account identifiers, refresh material, and account-to-
  storage bindings unless a release note explicitly documents a removal;
- a newly added collection starts from an empty value when older state has no
  equivalent data;
- an unknown newer schema stops provider initialization and is left untouched;
  the provider never attempts an automatic downgrade; and
- product migrations do not rewrite `vfs-toolkit-connections`. That record is
  owned by the vendored Toolkit and is reconciled with product bindings through
  its public connection lifecycle.

The current version 1 to version 2 migration therefore keeps authorized
accounts and consumer bindings, then lets the first change poll establish fresh
baseline tokens without replaying an old change history. A release that changes
the schema must add migration fixtures containing real account and binding data,
test that an unsupported newer version is not overwritten, and document any
rollback limit. Rolling back to a build that does not understand the current
schema requires a compatible Thunderbird-profile backup; runtime code does not
downgrade stored provider data.

`GoogleDriveChangeMonitor` polls one user change log and one log for every
visible Shared Drive per connected account, then fans the result out to all
current, uniquely matched VFS storage bindings for that account. The first poll
stores baseline tokens and does not replay older changes. Later non-empty
change entries or Shared Drive membership updates are coalesced into one
`directory/modified` report for `/` per storage binding. Drive tombstones and
moves do not contain a reliable old VFS path, and duplicate Drive names can also
change sibling paths, so the monitor does not invent item-level events. It
reports storage changes before committing the new cursors; after an interrupted
run, a refresh can repeat but is not silently skipped.

At startup, the connection service re-reports an outdated capability set for
each uniquely matched local binding through the Toolkit helper. It does not
write Toolkit connection records directly. A failed update leaves the binding
in place and can be tried again after the next background start.

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

The mutation namespace resolves existing targets through those same visible
paths. New path segments received from a VFS client remain literal so valid
filenames containing percent or tilde characters are not decoded as provider
metadata. File creates and folder creates check the target parent's Drive
capabilities, create missing parents in order, retain resource keys, and reject
writes at virtual roots. Binary overwrite updates the selected Drive item by ID;
Google-native files and shortcuts are not replaced with binary media. A normal
move uses one Drive metadata update to change the item's name and parent without
transferring file content. The request includes resource keys for the item, old
parent, and new parent when present. Item move/rename capabilities and the
destination parent's add-child capability are checked before that update.

File overwrite moves the existing target to the Drive trash before moving the
source. Folder merge first builds a complete action list. Unique children move
to the target, conflicting target files move to the trash before their source
files replace them, matching child folders merge recursively, and emptied source
folders move to the trash. A type conflict stops the request before the first
metadata update. Google Drive does not permit every cross-drive folder move, so
the namespace rejects combinations the API cannot perform. A move that stops
after one or more metadata updates reports the completed entry changes through
the provider adapter.

File copies use Drive's server-side copy endpoint and do not read file content
through the extension. Folder copies build a complete action list before the
first write, create destination folders, and copy each file through Drive.
Existing destinations require the caller's explicit overwrite or merge option.
If a copy stops after changing Drive, the provider reports the stable destination
parent so connected clients can refresh paths whose copied Drive IDs may differ
from their source IDs.

Delete resolves the same visible paths, checks the selected item's `canTrash`
capability, and updates its `trashed` metadata. A selected shortcut is trashed by
its own ID rather than modifying its target.

## 7. VFS operations

The provider API exposes callbacks for:

- listing and storage usage;
- reading and writing files;
- adding folders;
- moving and copying files or folders;
- deleting files or folders; and
- canceling a request.

The current provider advertises `file.read`, `file.add`, `file.modify`,
`file.delete`, `folder.read`, `folder.add`, `folder.modify`, and
`folder.delete`. It implements root and folder listing, storage quota, binary
download, Workspace export, new and replacement file upload, recursive folder
creation, file and folder moves and copies, folder merge, removal to the Google
Drive trash, localized VFS errors, progress, and request-scoped cancellation.
The account binding and requested capability are checked for every operation.

`writeFile` requests `file.add` for a new target and `file.modify` for an
overwrite. Move and copy requests use `file.modify` or `folder.modify`; the
Toolkit has no separate copy capability. Delete requests set the selected Drive
item's `trashed` field and do not call Drive's permanent-delete endpoint. File
creation, replacement, folder creation, move, copy, merge, and delete report
progress through the Toolkit request ID and use the same abort registry as read
operations. Multi-step move and copy failures or cancellations report changes
made before the operation stopped, as described by the upstream provider guide.
Upload strategy and Drive change polling remain product-owned work and are not
part of the vendored Toolkit.

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
[VENDOR.md](../VENDOR.md). The notices shipped in the XPI are recorded in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

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

Manual Thunderbird, VFS compatibility, Google Drive, restart, and release
evidence requirements are defined in [TESTING.md](TESTING.md).

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
6. Update `README.md`, `PRIVACY.md`, `docs/ADMIN.md`, `docs/DEVELOPMENT.md`,
   `Translations.md`, or `VENDOR.md` when their statements change.
7. Run `npm run test:unit` and `npm run test:review`. Run `npm test` before the
   first release candidate or review handoff.

## 12. Pending release inputs

The implementation still needs these inputs or later release decisions:

- a project-owned production Google OAuth Desktop client ID;
- the final product icon and Google brand review;
- the oldest Thunderbird version verified by smoke testing;
- release signing, update channel, and managed deployment.
