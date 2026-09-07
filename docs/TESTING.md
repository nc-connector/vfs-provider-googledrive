# Test Guide — VFS Provider for Google Drive

This guide defines the checks and evidence required for a release candidate.
Automated checks cover the repository in isolation. Thunderbird, VFS Toolkit,
and Google Drive behavior must also be exercised manually against the packaged
XPI.

## 1. Test environments

Use disposable Google data and fresh Thunderbird profiles. The release matrix
needs:

- the latest maintenance release in the Thunderbird 140 ESR line, which is the
  oldest supported major version;
- the current Thunderbird ESR at candidate time;
- a Google Cloud development project configured as described in
  [ADMIN.md](ADMIN.md);
- one regular Google account with My Drive content;
- one Google Workspace account that belongs to a Shared Drive;
- two compatible VFS consumers when testing connection isolation; and
- test folders containing binary files, Google Workspace files, shortcuts,
  duplicate names, empty folders, and enough children to cross a Drive API
  result page.

Do not use production documents or production OAuth credentials. Remove the
temporary Drive data and revoke test grants after the run.

## 2. Automated checks

Install the recorded development dependencies before running repository tests:

```sh
npm ci
```

Run the unit suite after each functional change:

```sh
npm run test:unit
```

The automated suite reconstructs account, session, and connection services
against the same extension storage and replaces the active-request registry
with a fresh instance. It checks token refresh, interrupted and completed setup
bindings, and the rule that an active transfer is not resumed from process
memory.

Run source review, vendor hash checks, a reproducible review build, and the XPI
file-list comparison:

```sh
npm run test:review
```

Immediately before a release candidate or review handoff, run the complete
check. It downloads a fresh copy of Thunderbird's current WebExtension linter:

```sh
npm test
```

Create the candidate only from the reviewed commit:

```sh
npm run build
```

Record the commit ID and SHA-256 of the resulting XPI before manual testing.
Do not rebuild under the same evidence record after a source change.

## 3. Thunderbird and VFS matrix

Run every applicable case on both supported Thunderbird endpoints. Repeat VFS
operation cases with the upstream unmodified API 1.3 example client.

| Area | Case | Expected result |
| --- | --- | --- |
| Install | Install and restart without opening settings | No Google authorization window opens; the provider starts without an error. |
| Settings | Open settings in light and dark themes | All controls are readable and localized; no credential value appears outside its input. |
| Account | Connect two different Google accounts | Both accounts remain separate and show the correct identity. |
| Account | Reauthorize one account | The selected identity is required and the other account remains unchanged. |
| Connection | Create, rename, and switch an account-bound connection | The consumer sees the current name and only the selected account's storage. |
| Connection | Connect two consumers to the same account | Each consumer gets its own storage ID and both remain usable. |
| Connection | Revoke one consumer in the provider settings | Only the selected connection disappears; the other consumers and Google account remain usable. |
| Connection | Revoke a connection whose consumer is unavailable | The stored connection and account binding are removed without blocking the settings page. |
| Isolation | Use a stale, foreign, or removed storage ID | The operation is rejected without accessing Google Drive. |
| Browse | Open My Drive, Shared with me, and Shared drives | Each virtual root lists only its intended content and all pages are returned. |
| Names | Browse duplicate and path-like names | Every item remains separately addressable and its displayed path stays stable. |
| Shortcut | Open file and folder shortcuts | The target is used for reading while mutations of the shortcut affect the shortcut itself. |
| Read | Read binary, empty, and Google Workspace files | Binary bytes match; empty files remain empty; each Workspace file uses the selected export format. |
| Upload | Add files at, below, and above 5 MB | Multipart is used through 5 MB and resumable upload above 5 MB; content and progress are correct. |
| Replace | Replace a writable binary file | The selected Drive item keeps its identity and receives the new content. |
| Folder | Create nested missing folders | All requested folders are created once and collisions return a usable error. |
| Move | Rename and move files and folders | Metadata changes without a content download; unsupported cross-drive folder moves are rejected. |
| Copy | Copy files and folder trees | File content is copied within Drive; folder structure and duplicate handling match the request. |
| Merge | Merge folders with and without conflicts | Completed work is reported; emptied source folders and replaced targets move to trash. |
| Delete | Delete a file, folder, Workspace file, and shortcut | The selected item moves to Google Drive trash and is not permanently deleted. |
| Cancel | Cancel reads, uploads, folder copies, and moves | Work stops at a safe boundary, progress stops, and later operations still succeed. |
| Quota | Read limited and unlimited quota responses | Used space is reported; an absent Google limit is not replaced with a made-up limit. |
| Refresh | Change Drive content outside Thunderbird | Within the polling interval, each connected consumer receives a storage refresh. |

## 4. Shared Drive cases

Use at least one writable Shared Drive and, where available, an account with a
restricted role:

- browse more than one Shared Drive and a paginated folder;
- read, export, upload, replace, copy, move, and trash content allowed by the
  selected account's role;
- confirm that forbidden operations return a permission error without partial
  hidden work;
- confirm file operations include Shared Drive handling while unsupported
  cross-drive folder moves remain rejected; and
- add or remove Shared Drive membership, then confirm the next change poll
  refreshes the connected VFS storage.

## 5. Network, retry, and restart cases

Run these cases with disposable files and retain the provider's redacted log:

- expire an access token and confirm one refresh serves concurrent requests;
- revoke a Google grant, confirm the account is marked for reauthorization,
  and reconnect it through **Sign in again**;
- interrupt a safe read before a retry and confirm cancellation stops backoff;
- stall token exchange or refresh beyond 30 seconds and confirm the operation
  reports a network failure without marking a connected account for
  reauthorization;
- stall a Drive request before response headers beyond five minutes and confirm
  a safe read retries while an uncertain metadata or multipart write does not;
- exercise an HTTP 429 or documented Drive rate-limit response and confirm the
  bounded retry behavior;
- interrupt or time out a resumable upload response and confirm the provider
  queries the server-confirmed offset before continuing;
- close an unfinished connection setup and confirm no account binding is
  published;
- restart Thunderbird with idle accounts and connections, then browse without
  repeating setup;
- restart Thunderbird during account setup and during an active upload, confirm
  no orphaned connection becomes usable, and retry the interrupted user action;
- restart after change cursors exist and confirm old changes are not replayed;
  and
- stop Thunderbird during an active transfer, then confirm the old request is
  not left active and a new request can be started after launch.

An interrupted mutation can have completed remotely even when its response was
lost. The test result must record the actual Drive state instead of assuming a
failed client response rolled the operation back.

## 6. Benchmark and compatibility run

Run the upstream VFS example client's full provider test set and benchmark.
Record every skipped, failed, and passed operation. A benchmark number is a
comparison aid, not a pass criterion; Google account type, network, file sizes,
and Drive throttling must be recorded beside it.

Repeat discovery, setup, browse, read, write, move, copy, delete, cancellation,
and change refresh with an unmodified API 1.3 client. Do not replace the
packaged Toolkit with a locally edited client or provider module for this run.

## 7. Evidence record

Keep one record per candidate with:

- release version, Git commit, XPI file name, and XPI SHA-256;
- test date, operating system, and exact Thunderbird version;
- VFS client name, version, add-on ID, and Toolkit API version;
- Google Cloud project audience/status without client credentials;
- account types used, including whether Shared Drives were available;
- pass, fail, or not-applicable status for every matrix row;
- sanitized logs for retry, cancellation, resumable upload, and change polling;
- screenshots of setup consent, the three virtual roots, and localized settings;
  and
- issue links for accepted failures or upstream limitations.

Never attach access tokens, refresh tokens, authorization codes, client secrets,
full account identifiers, private file names, or file content to the evidence.

## 8. Release gate

A candidate is ready for submission only when:

- unit, review, package, and fresh linter checks pass on the candidate commit;
- the oldest supported Thunderbird and current ESR matrix passes;
- the upstream example client and an unmodified API 1.3 client pass;
- My Drive and Shared Drive live cases pass;
- restart, token-expiry, retry, resumable-upload, and polling cases pass;
- the packaged documentation matches the observed behavior; and
- every remaining failure is fixed or explicitly removed from the release
  scope before submission.
