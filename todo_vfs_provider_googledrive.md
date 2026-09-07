# Google Drive VFS provider work plan

This file tracks the implementation plan and current project status and is
kept in sync with the repository.

## Product decisions

- [ ] Register the production Google OAuth application and record its client ID.
- [ ] Decide whether releases use one project-owned OAuth client or optionally
  support administrator-provided client IDs.
- [x] Confirm the Drive scope. A full VFS tree needs access beyond files created
  or explicitly opened by this add-on; document the Google verification impact
  before requesting a restricted scope. The provider uses the restricted full
  Drive scope and documents its verification impact.
- [x] Product scope includes My Drive, shared-with-me items, Shared Drives,
  shortcut resolution, and exported Google Workspace files.
- [x] Define the selectable export format per Google Workspace file type:
  Docs to DOCX or PDF, Sheets to XLSX or PDF, Slides to PPTX or PDF, and
  Drawings to PDF.
- [ ] Replace the neutral development icon with an approved product icon that
  follows Google branding rules without implying that Google publishes the
  add-on.
- [ ] Confirm the initial Thunderbird support range. The scaffold starts at
  Thunderbird 140 and has no Experiment API.

## Foundation

- [x] Add an MV3 manifest with a modular event background and minimum permissions.
- [x] Vendor the VFS provider and i18n modules without changes from fixed upstream
  commits; record source URLs, licenses, and hashes.
- [x] Add a build that packages only `src/` and does not download or rewrite
  dependencies during packaging.
- [x] Add review checks for manifest shape, locale parity, vendor integrity,
  package contents, encoding, and generated artifacts.
- [x] Add GitHub Actions for the review aggregate and the current Thunderbird
  webext-linter.
- [x] Add all family locales and keep every visible string translated. DE/EN are
  required product languages; the family rule additionally keeps all 15 locale
  catalogs complete.
- [x] Add `docs/ADMIN.md`, `docs/DEVELOPMENT.md`, `Translations.md`, and the root
  README without claiming unfinished runtime behavior.

## Runtime architecture

- [x] Keep Google accounts separate from VFS consumer connections so several
  add-ons can reuse one authorized account without sharing connection records.
- [x] Implement OAuth with PKCE through a documented Thunderbird MV3 identity
  API flow. Never log authorization codes, access tokens, refresh tokens, or
  Authorization headers.
- [x] Store account metadata and refresh material in persistent WebExtension
  storage; keep access tokens short-lived and replaceable. Document that
  Thunderbird does not expose a documented OS credential store to ordinary
  WebExtensions and do not claim encrypted-at-rest storage.
- [x] Register VFS and lifecycle listeners at module evaluation so an MV3
  background restart can receive work before asynchronous account loading.
- [x] Block account removal while a Toolkit-owned consumer connection still
  uses it. Reconcile the product binding after the consumer removes its
  connection; do not modify Toolkit records behind the lifecycle API.
- [x] Maintain request-scoped AbortControllers only for active operations; no
  completed or recoverable operation may depend solely on module globals.
- [x] Use stable Drive item IDs internally. Treat VFS paths as a presentation and
  lookup layer because Drive permits duplicate names and parent changes.
- [x] Define explicit behavior for duplicate sibling names, shortcuts, trashed
  items, shared items, and Shared Drive roots before exposing them in the picker.
- [x] Map current read-side Google and transport failures to `E:AUTH` or
  `E:PROVIDER`
  with localized user guidance.
- [x] Retry rate limits and transient transport failures with bounded exponential
  backoff and `Retry-After`; report offline and exhausted retries clearly.
  This includes response-body failures, deferred long `Retry-After` values, and
  localized VFS-facing error text.

### Implemented building blocks

- [x] Add one authenticated Drive transport for API, upload, and validated
  resumable-session requests; preserve `Location`, HTTP 308, and `Range` without
  creating a second upload transport.
- [x] Add paginated read helpers for quota, metadata, binary download, Workspace
  export, file listing, and Shared Drive listing.
- [x] Add metadata-first multipart upload for files up to 5 MB and resumable
  8 MiB chunk upload above that limit. Base progress on Drive-confirmed byte
  ranges, query uncertain sessions before continuing, and allow one in-request
  restart after Drive rejects a session.
- [x] Add tested path, duplicate-name, Workspace-export, and request-abort
  modules and use them from the provider adapter.
- [x] Add the Drive namespace operations for binary file create/replace and
  recursive folder creation. They preserve literal client filenames, stable
  duplicate IDs, Shared Drive boundaries, link-shared resource keys, and Drive
  write capabilities. VFS exposes create-only file and folder callbacks;
  replacement remains internal until `file.modify` is ready.

## VFS operations

- [x] `storageUsage`: map Drive quota usage and limit without inventing a limit.
- [x] `list`: return only direct children with file/folder type, size, and modified
  time; support pagination, My Drive, shared-with-me views, Shared Drives, and
  the required `supportsAllDrives`, `includeItemsFromAllDrives`, `corpora`, and
  `driveId` parameters.
- [x] `readFile`: download binary files and export Google Docs to DOCX/PDF,
  Sheets to XLSX/PDF, Slides to PPTX/PDF, and Drawings to PDF.
- [x] `writeFile`: create new files, create missing parents required by the VFS
  interface, use resumable upload for large files, and report progress.
- [ ] `writeFile` replacement: expose the existing binary replacement path only
  after the complete `file.modify` operation family is ready.
- [x] `addFolder`: create every missing parent while preserving collision rules
  and report progress for each created path segment.
- [ ] File/folder move: update parents and names with explicit overwrite/merge
  behavior.
- [ ] File/folder copy: use Drive server-side copy where supported and report
  partial folder results on cancel or error.
- [ ] File/folder delete: define trash versus permanent deletion and expose only
  the selected behavior.
- [x] Cancellation for list, file read, new file upload, and folder creation by
  Toolkit request ID.
- [ ] Partial mutation reporting: report work that completed before a future
  multi-item operation stopped.
- [ ] Change notifications: persist a Drive Changes page token and schedule checks
  with an MV3-compatible event rather than relying on `setInterval()`.
- [x] Advertise every current VFS capability only after its callback and error
  path passes the provider API tests.
- [x] Update existing unique account-bound Toolkit connections through the
  Toolkit helper when the advertised capability set changes.

## User interface

- [x] Setup popup: authorize or reuse a Google account, show the requesting add-on
  name and ID,
  and grant one account-bound VFS connection.
- [x] Connection config popup: rename the picker entry and switch/re-authorize the
  associated account without exposing tokens.
- [x] Options page: add/re-authorize/remove unused accounts, configure export
  formats and debug logging, and show actionable authentication state.
- [ ] Options page: list consuming add-ons and revoke individual VFS connections
  once the Toolkit exposes a provider-side removal method.
- [x] Use the Thunderbird-family visual language and support light/dark themes.

## Tests and release readiness

- [x] Cover every advertised VFS capability, including missing parents,
  duplicate names, pagination, empty folders, conflict errors, progress, and
  cancellation.
- [ ] Cover overwrite/merge and partial multi-item results before advertising
  the related capabilities.
- [ ] Cover background restart during idle state, token refresh, change polling,
  setup, and active transfer boundaries.
- [ ] Run the upstream VFS example-client tests and benchmark against the provider.
- [ ] Test interoperability with an unmodified API 1.3 VFS client.
- [ ] Follow up upstream on serializing Toolkit connection record mutations.
  Concurrent setup/config updates and consumer removal currently use separate
  read-modify-write operations in the Toolkit.
- [x] Verify current logs contain useful phases but no credentials, tokens, file content,
  or full sensitive request URLs.
- [ ] Run the complete review matrix and a freshly downloaded Thunderbird
  webext-linter before every committed product change.
- [ ] Smoke-test the XPI on the oldest supported Thunderbird and the current ESR.
- [ ] Run live tests against My Drive and a real Shared Drive, including token
  expiry, refresh, rate-limit retry, resumable upload, and change polling.
- [ ] Complete setup, Google Cloud Console, OAuth scope, Shared Drive, export,
  security, testing, and ATN release documentation.
- [ ] Add a release changelog and complete license and third-party notices before
  the first release candidate.
- [ ] Verify the reproducible release XPI contains exactly the reviewed source
  payload and no development-only files.
