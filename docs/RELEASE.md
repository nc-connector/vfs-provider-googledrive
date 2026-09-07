# Release Guide — VFS Provider for Google Drive

This guide covers the first ATN submission and later releases. A release is cut
only after every applicable gate below is complete for the exact candidate XPI.

Official review references:

- [Thunderbird ATN review policy](https://thunderbird.github.io/atn-review-policy/)
- [Thunderbird add-on reviewer guide](https://github.com/thunderbird/addon-reviewer-guide/blob/main/add-on-review-guide.md)
- [Mozilla source submission guide](https://extensionworkshop.com/documentation/publish/source-code-submission/)
- [Mozilla third-party library guide](https://extensionworkshop.com/documentation/publish/third-party-library-usage/)

## 1. First-release decisions

Settle these values before changing the package from development status:

- final product name, approved icon, and Google trademark presentation;
- permanent Gecko add-on ID; it cannot be changed after publication without
  creating a different add-on identity;
- release version and supported Thunderbird range;
- production Google Cloud project, Desktop OAuth client ID, audience, and
  restricted-scope verification status;
- project-controlled homepage, issue tracker, support contact, and privacy
  contact;
- final ATN listing summary, description, categories, screenshots, license, and
  supported languages; and
- listed or self-distributed release channel and any managed-deployment policy.

The production OAuth consent screen, ATN listing, manifest, privacy policy, and
user interface must use the same product identity and describe the same data
flow.

## 2. Upstream and vendor gate

The packaged VFS provider module currently tracks the review revision from
[thunderbird/webext-support PR #96](https://github.com/thunderbird/webext-support/pull/96).
Before submission, replace that review revision with the merged upstream commit
when available. If the pull request has not merged, confirm with ATN reviewers
whether the pinned Thunderbird-owned revision is acceptable for the candidate.

For every vendored file:

- keep the file byte-for-byte identical to the recorded upstream source;
- record an immutable source URL, revision, license, and SHA-256 in
  [VENDOR.md](../VENDOR.md);
- update [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md); and
- include the immutable upstream links in Notes for Reviewers.

Do not carry local Toolkit patches into a release candidate.

## 3. Freeze the candidate

1. Finish the release scope and remove or postpone every unresolved release
   blocker.
2. Update the version in `src/manifest.json` and the matching release heading in
   `CHANGELOG.md`.
3. Update `README.md`, `PRIVACY.md`, `docs/ADMIN.md`, `docs/DEVELOPMENT.md`,
   `docs/TESTING.md`, `Translations.md`, `VENDOR.md`, and
   `THIRD_PARTY_NOTICES.md` wherever behavior or source inputs changed.
4. Confirm all locale files contain the same keys and reviewed translations.
5. Confirm the working tree is clean and create the candidate from that commit.
6. Run the complete matrix in [TESTING.md](TESTING.md) and retain its evidence.

Do not mix unrelated feature work or refactoring into a review correction.

## 4. Build and artifact checks

From a clean checkout with Node.js 22 or newer:

```sh
npm ci
npm test
npm run build
```

Run the package allowlist check against the resulting file, adjusting the file
name for the release version:

```sh
node tools/package-check.js dist/vfs-provider-googledrive_0_1_0.xpi
```

Record:

- Git commit and release tag;
- Node.js and npm versions;
- XPI file name, size, and SHA-256;
- unit, review, package, dependency, and fresh Thunderbird linter output; and
- a second clean-build SHA-256 from the same commit.

The two unsigned builds must match. Inspect the archive and reject it if it
contains `node_modules`, `.git`, `.tmp`, `dist`, the project work plan, test
credentials, OAuth tokens, secrets, logs, private test data, or an unreviewed
file.

## 5. Manifest and permission review

Compare every manifest entry with the packaged implementation:

- `alarms` wakes periodic Drive change checks;
- `identity` opens the Google OAuth flow;
- `storage` holds accounts, tokens, bindings, cursors, and preferences;
- `https://oauth2.googleapis.com/*` is used for token exchange and revocation;
  and
- `https://www.googleapis.com/*` is used for Drive API and upload requests.

The release must not add broad host access, an Experiment API, native messaging,
remotely executed code, or a self-hosted `update_url` without a separately
reviewed requirement. Confirm the final add-on ID, minimum Thunderbird version,
homepage, author, name, description, version, and icons before packaging.

## 6. Privacy and consent review

ATN requires the full add-on-specific privacy text in its privacy policy field.
Paste the current [PRIVACY.md](../PRIVACY.md) text there; a link alone is not
sufficient. Summarize the same data flow in the public listing:

> The add-on sends Google account authorization data, Drive metadata, and files
> directly between Thunderbird and Google to provide user-approved VFS storage
> connections. Account and connection state is stored in the Thunderbird
> profile. It does not use a developer-operated server, advertising, analytics,
> or remote telemetry.

Verify in the candidate that:

- no authorization begins before the user selects **Add account** after seeing
  the Drive-access disclosure;
- the VFS setup page shows the consumer name and ID before the user grants the
  account-bound connection;
- periodic change polling is described even though it runs without a new click
  after a connection is granted;
- Google and connected VFS consumers are identified as data recipients;
- account removal, remote revocation, local retention, Drive trash behavior,
  and diagnostics match the privacy text; and
- any future telemetry, additional host, server, or data use is disabled until
  its policy, consent, and release review are complete.

## 7. ATN listing and test access

The listing must explain:

- that this is a storage provider used by compatible Thunderbird VFS consumers;
- where users add Google accounts and create consumer connections;
- the My Drive, Shared with me, Shared Drives, Workspace export, upload, move,
  copy, trash, change-refresh, and multi-account behavior actually shipped;
- that a Google account is required and Shared Drives depend on the user's
  Google Workspace edition, membership, and role;
- all current limitations; and
- where users can get support and report privacy or security issues.

Provide screenshots through ATN's screenshot fields rather than embedding
promotional links in the description.

ATN reviewers need enough information to exercise account-dependent features.
Use a dedicated disposable Google test account and non-sensitive Drive data.
Provide credentials only through the private review channel. If Google requires
explicit test-user allowlisting, coordinate the reviewer account in that same
channel. Never add credentials to the repository, XPI, public listing, commit,
or issue tracker.

## 8. Notes for Reviewers template

Fill in every placeholder and remove inapplicable lines before submission:

```text
Purpose:
This Thunderbird MV3 add-on exposes user-approved Google Drive accounts to
compatible add-ons through VFS Toolkit API 1.3.

Entry points:
Open Add-ons Manager -> VFS Provider for Google Drive -> Preferences to enter
the OAuth client ID and add an account. Create a connection from a compatible
VFS consumer; the provider setup shows the consumer name and ID.

Test account:
[Private test-account instructions or reviewer allowlisting process]

Network and data:
The add-on communicates only with accounts.google.com for interactive consent,
oauth2.googleapis.com for OAuth tokens/revocation, and www.googleapis.com for
Drive API/upload operations. See the submitted privacy policy for the complete
data flow. No developer server or telemetry is used.

Permissions:
alarms: periodic Drive change checks
identity: interactive Google authorization
storage: local account, connection, cursor, token, and preference state
Google host permissions: OAuth token and Drive API requests

Third-party source:
[Immutable VFS Toolkit URL, revision, license, and SHA-256]
[Immutable i18n module URL, revision, license, and SHA-256]
Both packaged files are unchanged; details are in VENDOR.md and
THIRD_PARTY_NOTICES.md.

Build:
Node.js [version], npm [version]
npm ci
npm test
npm run build
The build only creates the XPI and does not minify, bundle, or rewrite source.

Manual testing:
[Thunderbird versions, VFS client version, My Drive and Shared Drive results]

Known limitations:
[None, or exact release limitations]
```

The XPI contains readable source. If ATN requests a separate source archive,
provide the exact candidate checkout, lockfile, build tools, and these build
instructions. Exclude `.git`, `node_modules`, `dist`, `.tmp`, credentials,
private evidence, and unrelated local files.

## 9. Submission and response

1. Upload the unsigned candidate XPI to its new ATN listing. Later releases must
   use that existing add-on identity rather than creating another listing.
2. Resolve every validator error and review every warning before continuing.
3. Enter the listing, full privacy policy, support information, license, release
   notes, compatibility, and Notes for Reviewers.
4. Attach source only when requested by the submission flow or reviewer, using
   the exact candidate commit and build instructions.
5. Save the submitted file, its SHA-256, the submission time, and the ATN version
   record with the test evidence.
6. Answer reviewer questions promptly and put requested fixes in a focused new
   version without unrelated changes.

After approval, retain both the submitted and ATN-signed artifacts and record
their separate hashes. Publish the matching tag and release notes. Verify a
fresh ATN installation and update before announcing the release.

## 10. Rollback and security response

Do not reuse or decrease a published version number. If a release must be
withdrawn, stop distribution where possible, document the reason, fix the
smallest affected scope, publish a higher replacement version, and tell users
whether Google grants or local data require action.

For a credential or data-handling incident, revoke affected OAuth credentials,
preserve non-sensitive diagnostic evidence, notify the applicable services and
users, and update the privacy and security documentation before distribution
resumes.
