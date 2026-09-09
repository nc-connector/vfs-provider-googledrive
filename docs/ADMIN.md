# Administration Guide — VFS Provider for Google Drive

This guide is for administrators and operations teams that prepare, deploy,
operate, and remove VFS Provider for Google Drive. Source layout, build
commands, test implementation, and release preparation belong in
[DEVELOPMENT.md](DEVELOPMENT.md).

## Contents

- [1. Service scope](#1-service-scope)
- [2. Requirements](#2-requirements)
- [3. Install, update, and roll back](#3-install-update-and-roll-back)
- [4. Initial configuration](#4-initial-configuration)
- [5. Operational behavior and limits](#5-operational-behavior-and-limits)
- [6. Enterprise rollout](#6-enterprise-rollout)
- [7. Operational checks](#7-operational-checks)
- [8. Troubleshooting](#8-troubleshooting)
- [9. Logging and support data](#9-logging-and-support-data)
- [10. Backup, recovery, and offboarding](#10-backup-recovery-and-offboarding)

## 1. Service scope

VFS Provider for Google Drive makes user-approved Google Drive accounts
available to compatible Thunderbird add-ons through the Thunderbird VFS
Toolkit.

The provider supports:

- separate authorization for multiple Google accounts;
- a separate VFS connection for each consumer add-on and selected account;
- My Drive, Shared with me, and Shared drives;
- file and folder browsing;
- binary file downloads and uploads;
- Google Docs, Sheets, Slides, and Drawings exported as regular files;
- folder creation, rename, move, copy, merge, and removal to Drive trash;
- file replacement, rename, move, copy, and removal to Drive trash;
- request progress and cancellation; and
- refresh notifications after remote Drive changes.

The provider does not read Thunderbird messages, address books, or calendars.
It does not operate a project-owned server and does not send telemetry. Google
Drive remains the system that stores the files.

A consumer add-on receives no access merely because both add-ons are installed.
The user must review the requesting add-on, select a Google account, and grant
an account-bound VFS connection.

## 2. Requirements

### 2.1 Client and account requirements

- Thunderbird 140.0 or newer
- an approved VFS Provider for Google Drive XPI
- a compatible Thunderbird VFS consumer
- a Google account permitted to authorize the effective Google OAuth
  application
- Google Workspace membership and a suitable Drive role for Shared Drive use

Google permissions still apply after a VFS connection is granted. The provider
cannot raise a user's Drive role, grant Shared Drive membership, or bypass an
organization's Google Workspace controls.

### 2.2 Thunderbird permissions

The add-on requests only these Thunderbird permissions:

| Permission | Operational use |
| --- | --- |
| alarms | Check connected Drive accounts for remote changes every five minutes |
| identity | Open Google's interactive authorization flow |
| storage | Store accounts, refresh grants, VFS bindings, change cursors, preferences, and optional local OAuth client configuration in the Thunderbird profile; read administrator OAuth policy from managed storage |

The add-on does not use Thunderbird Experiment APIs, native messaging, or
remotely loaded executable code.

Treat the Thunderbird profile as credential-bearing data. Refresh tokens are
stored in extension storage inside that profile rather than in an operating
system credential vault. Access tokens and unfinished authorization data are
kept only in session storage.

### 2.3 Network access

Thunderbird clients need HTTPS access to:

| Host | Use |
| --- | --- |
| accounts.google.com | Interactive Google sign-in and consent |
| oauth2.googleapis.com | Token exchange, refresh, and revocation |
| www.googleapis.com | Google Drive API, downloads, exports, and uploads |

Firewalls, proxies, and TLS inspection must permit GET, POST, PATCH, and PUT.
They must not remove the Authorization, Content-Type, Content-Range, Range,
X-Upload-Content-Type, X-Upload-Content-Length, or
X-Goog-Drive-Resource-Keys headers.

Set proxy request-size and timeout limits for the largest supported upload.
One OAuth or account request stops after 30 seconds without a completed
response. A Drive request stops after five minutes if response headers have not
arrived. The five-minute limit covers transmitting one multipart request or one
resumable chunk; it is not a total-duration limit for a download after headers
arrive.

## 3. Install, update, and roll back

### 3.1 Individual installation

**Goal:** Install an approved build in one Thunderbird profile.

**Prerequisites:**

- a signed or otherwise organization-approved XPI;
- Thunderbird 140.0 or newer.

**Steps:**

1. Open Thunderbird's Add-ons Manager.
2. Select **Install Add-on From File** and choose the approved XPI.
3. Restart Thunderbird when requested.
4. Open **Add-ons Manager → VFS Provider for Google Drive → Preferences**.
5. Complete [Initial configuration](#4-initial-configuration).

**Expected result:** The options page opens without starting Google sign-in,
and a compatible VFS consumer can discover the provider.

**Verification:** Run the first four checks in [Operational
checks](#7-operational-checks).

**Rollback:** Remove the add-on or reinstall the previously approved version.
Before downgrading, follow [Rollback](#33-rollback) because newer provider
state may not be readable by an older build.

### 3.2 Managed update

1. Retain the currently approved XPI and a protected profile backup from the
   same version.
2. Validate the new XPI with the organization's Thunderbird, Google account,
   proxy, and VFS consumer combinations.
3. Test one small upload, one resumable upload, one Workspace export, one
   remote refresh, and one restart.
4. Deploy to a pilot group.
5. Review provider logs and Google Workspace audit data for failures.
6. Expand the rollout only after the pilot checks pass.

Updating the add-on does not itself open an authorization window. Existing
accounts and consumer connections remain unless a release note explicitly
states otherwise.

### 3.3 Rollback

Provider state uses versioned records in the Thunderbird profile. A new release
may migrate those records forward. It does not automatically downgrade them.

**Prerequisites:** A profile backup created while the previous add-on version
was installed and the matching approved XPI.

**Steps:**

1. Stop distribution of the newer XPI.
2. Close Thunderbird.
3. Restore the version-matched profile backup.
4. Install the matching previous XPI through the normal deployment channel.
5. Start Thunderbird and run [Operational checks](#7-operational-checks).

**Expected result:** Accounts and VFS connections match the restored profile
state, and the previous provider version can browse and transfer test data.

Installing an older XPI over an unknown newer provider-state version is not a
supported rollback method. The provider leaves unknown newer state untouched
instead of guessing how to downgrade it.

## 4. Initial configuration

The released add-on includes the publisher's Google Desktop OAuth client as the
built-in default. An unmanaged profile can instead save its own Desktop client.
Enterprise policy can lock the profile to either the built-in client or an
administrator-provided client. Account authorization and provider preferences
are stored per Thunderbird profile. Choosing an OAuth client does not authorize
an account; each Google account still needs an explicit user authorization.

### 4.1 Select the OAuth client

For the normal built-in configuration, leave **Built-in OAuth client** selected.
No client values need to be entered.

To use a client owned by the user or organization:

1. Complete the [custom Google client prerequisites](#63-managed-oauth-client-policy).
2. Open **Add-ons Manager → VFS Provider for Google Drive → Preferences**.
3. Select **Own Google OAuth client**.
4. Enter the complete Desktop client ID ending in
   `.apps.googleusercontent.com` and its client secret.
5. Save the OAuth configuration before adding or authorizing an account.

The client-secret field is password-style and the saved secret is never read
back into the page. When the same custom client ID is already stored, leaving
the field blank retains its current secret. A new or changed client ID requires
the matching secret. Invalid input is rejected without replacing the previous
configuration.

The local record is held in the Thunderbird profile, not an operating-system
credential vault. Selecting the built-in mode can leave the local custom pair
dormant so it can be selected again later. Like every installed Desktop client
configuration, these values must not be treated as confidential proof of the
application's identity.

When enterprise policy supplies an OAuth mode, the options page identifies the
managed source and selected mode and disables all OAuth controls. For managed
custom mode it also shows the client ID. Managed values cannot be changed or
removed from the add-on, and the client secret is never returned to the page.
See [Managed OAuth client policy](#63-managed-oauth-client-policy).

### 4.2 Configure provider preferences

1. Open **Add-ons Manager → VFS Provider for Google Drive → Preferences**.
2. Select the required Google Workspace export formats.
3. Leave **Enable diagnostic logging** off during normal operation.
4. Select **Save preferences**.

Expected result: the page reports that preferences were saved.

### 4.3 Add a Google account

1. Select **Add Google account**.
2. Review Google's application name and requested Drive access.
3. Sign in with the intended account and approve the request.
4. Return to the options page.

Expected result: the account appears under **Google accounts** with status
**Connected**.

Repeat the procedure for each account that users need. No account is added at
installation, Thunderbird startup, or merely by opening the settings.

If an account shows **Sign-in required again**, select **Sign in again** for
that account. The returned Google identity must match the stored account; the
provider does not silently replace it with another signed-in account.

### 4.4 Grant a VFS connection

Connections are initiated by a compatible consumer add-on, not from the
provider's options page.

1. In the consumer add-on, choose to add a VFS storage connection.
2. Select VFS Provider for Google Drive.
3. In the provider-owned setup window, verify the requesting add-on name and
   ID.
4. Select the intended Google account.
5. Review or change the displayed connection name.
6. Select **Connect**.

Expected result: the consumer receives one storage connection bound to that
consumer and account. Another consumer cannot reuse the connection without its
own user grant.

### 4.5 Revoke a connection or remove an account

To remove one consumer's access:

1. Open the provider options.
2. Find the entry under **VFS connections**.
3. Verify the consumer add-on and Google account.
4. Select **Revoke access** and confirm.

Expected result: only that consumer connection is removed. The Google account,
other consumer connections, and Drive files remain.

To remove a Google account:

1. Revoke every VFS connection that still uses the account.
2. Select **Sign out and remove** for that account.
3. Confirm the action.

The provider asks Google to revoke the grant and removes its local account
record. If remote revocation cannot be confirmed, it reports that the account
was removed locally. In that case, remove the app's access separately in the
user's [Google Account connections](https://myaccount.google.com/connections).

### 4.6 Google Workspace export formats

The export choices apply to all configured accounts:

| Google file | Available format | Initial setting |
| --- | --- | --- |
| Google Docs | DOCX or PDF | DOCX |
| Google Sheets | XLSX or PDF | XLSX |
| Google Slides | PPTX or PDF | PPTX |
| Google Drawings | PDF | PDF |

The selected extension appears in the VFS picker. Exporting does not modify the
Google Workspace source file. Google's
[files.export endpoint](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export)
limits the exported byte content to 10 MB.

## 5. Operational behavior and limits

### 5.1 Storage roots and access

Each connection exposes three virtual roots:

- **My Drive**
- **Shared with me**
- **Shared drives**

Shared Drives appear only when the selected Google Workspace account is a
member. Every operation follows the permissions Google reports for the account
and item. A visible item may therefore be readable but not writable, movable,
copyable, or trashable.

Google Drive permits duplicate names. The provider keeps duplicate siblings
separately addressable even when their visible names match. File and folder
shortcuts can be opened through their targets; changing or removing the
shortcut acts on the shortcut itself.

### 5.2 Uploads, copies, moves, and deletion

- Files up to and including 5,000,000 bytes use one multipart upload.
- Larger files use resumable upload with 8 MiB chunks.
- After an uncertain resumable response, the provider asks Drive which bytes
  were accepted before it continues.
- File copies use Google's server-side copy operation.
- Folder copies create the target tree and copy files within Drive.
- Ordinary moves change Drive metadata without downloading the file.
- Unsupported cross-drive folder moves are rejected.
- Delete operations move items to the recoverable Google Drive trash; the
  provider never permanently deletes Drive content.

A canceled or interrupted multi-step copy, move, or merge may already have
changed some Drive items. Inspect the source and destination before repeating
the operation.

### 5.3 Remote changes

The provider checks user and Shared Drive change logs every five minutes for
accounts with at least one current VFS connection. When it detects a change, it
asks each connected consumer to refresh that storage.

The first poll establishes a baseline and does not replay older Drive history.
An open picker may require a refresh or reopen after the notification.

### 5.4 File size and memory

The VFS interface returns a complete File object to the consumer. The provider
does not intentionally create a temporary disk cache for downloaded content.
Reading a very large Drive file can therefore require a similar amount of
available Thunderbird memory. Define an organizational size limit if client
devices cannot safely hold the largest expected file.

Drive quota is reported when Google supplies a finite limit. An account for
which Google reports no limit remains visible as unlimited rather than being
assigned an invented value.

## 6. Enterprise rollout

### 6.1 Add-on identity and policy locations

The provider uses this permanent add-on ID:

    {90c66d9f-a142-43a8-8ffb-707a48d8eb7a}

Use this ID for long-lived policy and deployment rules. Changing it would create
a different Thunderbird add-on identity and a different OAuth redirect.

Common policies.json locations:

- Windows: `C:\Program Files\Mozilla Thunderbird\distribution\policies.json`
- macOS: `/Applications/Thunderbird.app/Contents/Resources/distribution/policies.json`
- Linux: `/usr/lib/thunderbird/distribution/policies.json`, the `distribution`
  path used by the installed package, or the system-wide
  `/etc/thunderbird/policies/policies.json`

Use `about:policies` in Thunderbird to check policy discovery and parsing.

### 6.2 Force-install template

Replace the placeholder with the approved HTTPS XPI URL:

    {
      "policies": {
        "ExtensionSettings": {
          "*": {
            "installation_mode": "allowed"
          },
          "{90c66d9f-a142-43a8-8ffb-707a48d8eb7a}": {
            "installation_mode": "force_installed",
            "install_url": "<approved-xpi-url>",
            "updates_disabled": false
          }
        }
      }
    }

Do not deploy this template with the placeholder or before the add-on ID and
distribution URL are final. See Thunderbird's
[enterprise policy documentation](https://enterprise.thunderbird.net/manage-updates-policies-and-customization/managing-thunderbird-policies)
and Mozilla's
[ExtensionSettings reference](https://mozilla.github.io/policy-templates/#extensionsettings).

### 6.3 Managed OAuth client policy

Thunderbird exposes extension policy through its read-only `storage.managed`
area. This provider recognizes exactly these case-sensitive values below its
permanent add-on ID:

| Value | Requirement and effect |
| --- | --- |
| `OAuthMode` | Required when any supported OAuth policy value is deployed. `builtin` or `custom`. |
| `OAuthClientId` | Required for `custom`; a non-empty Google Desktop client ID ending in `.apps.googleusercontent.com`. Ignored for `builtin`. |
| `OAuthClientSecret` | Required and non-empty for `custom`. Ignored for `builtin`. |

To force the client included in the approved XPI, merge this block into the
existing `policies.json` object:

```json
{
  "policies": {
    "3rdparty": {
      "Extensions": {
        "{90c66d9f-a142-43a8-8ffb-707a48d8eb7a}": {
          "OAuthMode": "builtin"
        }
      }
    }
  }
}
```

To force an organization-owned client, first create and approve the client as
described below, then merge this block with the actual values:

```json
{
  "policies": {
    "3rdparty": {
      "Extensions": {
        "{90c66d9f-a142-43a8-8ffb-707a48d8eb7a}": {
          "OAuthMode": "custom",
          "OAuthClientId": "<desktop-client-id>.apps.googleusercontent.com",
          "OAuthClientSecret": "<desktop-client-secret>"
        }
      }
    }
  }
}
```

Do not deploy either example with placeholders. Keep the surrounding
`ExtensionSettings` force-install policy when both policies are required; the
`ExtensionSettings` and `3rdparty` objects are siblings below `policies`, not
alternative files.

The custom client must be an OAuth 2.0 **Desktop app** in a Google Cloud project
controlled by the deploying organization. Before rollout:

1. Enable the Google Drive API in that project.
2. Configure the Google Auth Platform branding, support contacts, audience, and
   test users or production publication status.
3. Declare and review the restricted
   `https://www.googleapis.com/auth/drive` scope.
4. Complete any Google verification or Workspace approval required for the
   intended audience.
5. Create a Desktop app client. Copy the `installed.client_id` and
   `installed.client_secret` string values from Google's credential JSON; do
   not place the whole JSON document in the policy.
6. Confirm that Google's consent page shows the expected organization-owned app
   identity and that the account is permitted to authorize it.

The person or organization that supplies the client owns its Google Cloud
configuration, consent-screen accuracy, verification, test-user and publication
status, quota, credential rotation, Workspace approval, and support. An
External application left in Testing can issue grants that expire after seven
days.

`policies.json` must be valid UTF-8 JSON and must be placed in a Thunderbird
policy location listed in [Add-on identity and policy locations](#61-add-on-identity-and-policy-locations).
After adding, changing, or removing managed OAuth values, fully exit and restart
Thunderbird. Thunderbird does not provide a reliable managed-storage change
event, and an extension reload is not a supported substitute for a browser
restart. Check `about:policies`, then open the provider options and confirm the
expected mode, managed source, and locked controls. The client secret itself is
never displayed.

Thunderbird does not enforce an extension-provided schema for managed storage,
so the provider validates the policy at runtime. The presence of any one of the
three supported keys activates managed mode and locks the local controls;
`OAuthMode` is then required. `builtin` deliberately ignores managed client
fields. `custom` fails closed if either field is absent, blank, the wrong type,
or invalid. An unknown mode, a partial OAuth policy, or a managed storage read
failure also fails closed; the provider does not silently use the local or
built-in client. Thunderbird's documented **Managed storage manifest not
found** result means that no extension policy is configured and is treated as
the normal unmanaged state.

The Desktop client secret is public installed-application configuration, not a
user password or a security boundary. It is nevertheless present in the policy
file, so restrict write access, avoid placing it in tickets or logs, and follow
the organization's configuration-retention rules. The provider reads managed
values into memory but does not copy them to `storage.local`, return the secret
to the options page, or log it.

Changing the effective client ID invalidates the provider's cached access tokens
and requires every account authorized under the previous ID to use **Sign in
again**. Account records, VFS connection bindings, and Drive files are retained;
the provider neither revokes the old Google grants nor deletes data
automatically. Replacing a secret while keeping the same client ID does not by
itself require reauthorization; the next token refresh uses the replacement
secret. After an ID change, revoke the previous application grants separately in
Google when the organization's offboarding policy requires it.

References:

- [Thunderbird managed-storage example](https://github.com/thunderbird/webext-examples/tree/master/manifest_v2/managedStorage)
- [Thunderbird storage API](https://webextension-api.thunderbird.net/en/esr-mv3/storage.html)
- [Thunderbird enterprise policy documentation](https://enterprise.thunderbird.net/manage-updates-policies-and-customization/managing-thunderbird-policies)
- [OAuth 2.0 for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

### 6.4 Google Workspace controls

When users see an administrator-policy error during Google authorization:

1. In the provider options, identify whether the effective client is built-in
   or custom. For a custom client, record its displayed client ID; for the
   built-in client, use the ID from the approved release records.
2. Open Google Workspace Admin app access controls.
3. Review the requested full Drive scope and the affected organizational unit.
4. Permit or trust only that effective OAuth application after the
   organization's security and data-handling review.
5. Ask the user to start **Add Google account** or **Sign in again** once more.

Expected result: Google shows the consent flow instead of
admin_policy_enforced. Do not weaken domain-wide controls for unrelated OAuth
clients. For a built-in client, product support owns application-level problems;
for a custom client, the deploying organization owns them.

### 6.5 Rollout verification

1. Open `about:policies` and check for policy parse errors.
2. Fully exit and restart Thunderbird.
3. Confirm that the add-on is installed and enabled.
4. Open its options and confirm the intended OAuth mode and source. For a
   managed policy, confirm that the controls are locked and the secret is not
   exposed.
5. Confirm that no sign-in starts automatically.
6. Connect a disposable Google account and verify the expected application name
   and client ID in Google's flow.
7. Grant one connection from the approved VFS consumer.
8. Complete [Operational checks](#7-operational-checks).

## 7. Operational checks

Run these checks after installation, update, rollback, OAuth-policy change,
proxy change, or a significant Google Workspace policy change:

| Check | Expected result |
| --- | --- |
| Cold start | Thunderbird starts without opening Google authorization and without a provider error |
| OAuth configuration | The options page shows the intended built-in or custom mode and local or managed source; managed controls are locked and no secret is displayed |
| Provider discovery | The approved VFS consumer lists VFS Provider for Google Drive |
| Account setup | The intended account appears as Connected |
| Connection grant | The setup window shows the consumer name and ID before access is granted |
| Browse | My Drive and Shared with me open; Shared drives opens for a member account |
| Small upload | A file no larger than 5,000,000 bytes uploads and can be read back |
| Large upload | A larger file completes through resumable upload and matches the source size |
| Workspace export | One Doc, Sheet, Slide, and Drawing opens in the configured format |
| Mutation | Create, rename, move, copy, and trash work where Drive permissions allow them |
| Remote refresh | A Drive change made outside Thunderbird becomes visible after the next poll and refresh |
| Restart | Existing accounts and connections remain usable after Thunderbird restarts |
| Revocation | Revoking one connection removes only that consumer's access |

Use disposable files and folders for mutation checks. Inspect both source and
destination after canceling or interrupting a multi-step operation.

## 8. Troubleshooting

### 8.1 Provider is not listed by a consumer

1. Confirm that both add-ons are enabled in the same Thunderbird profile.
2. Confirm Thunderbird is version 140.0 or newer.
3. Confirm the consumer supports the Thunderbird VFS Toolkit used by the
   provider.
4. Restart Thunderbird and retry provider discovery.
5. Enable diagnostic logging and check for the first [GDRVFS] startup error.

If another compatible consumer can discover the provider, investigate the
original consumer's discovery and permission settings.

### 8.2 Google sign-in does not start or cannot complete

Check:

- the installed XPI came from the approved product distribution channel;
- the options page shows the expected OAuth mode and source;
- a local custom client has a complete Desktop client ID and matching secret;
- a managed policy contains the exact case-sensitive keys from [Managed OAuth
  client policy](#63-managed-oauth-client-policy), `about:policies` reports no
  error, and Thunderbird was fully restarted after the last policy change;
- the Google account is active and can use Google Drive;
- Google Workspace app access controls permit the effective OAuth client;
- the system can reach all hosts in [Network access](#23-network-access); and
- the Google consent window was not canceled.

An incomplete, invalid, or unreadable managed OAuth policy fails closed instead
of falling back to a local or built-in client. Correct the policy and restart
Thunderbird. If Google reports an invalid, deleted, or unverified application,
record the exact Google error. Contact product support for the built-in client;
contact the organization's Google Cloud administrator for a custom client.

### 8.3 Account requires sign-in again

Common causes include a revoked grant, an account security change, a Google
Workspace policy change, or a change to the effective OAuth client ID.

1. Select **Sign in again** beside the affected account.
2. Choose the same Google identity.
3. Repeat a browse check.

If reauthorization repeatedly fails, check the Google Workspace app access
policy and contact product support with the exact Google error.

### 8.4 Shared Drives are missing or read-only

1. Confirm the account is a Google Workspace account with Shared Drive access.
2. Confirm the account is a member of the expected Shared Drive.
3. Check the account's role and the affected item's Drive capabilities.
4. Reopen or refresh the picker after a membership change.

An empty **Shared drives** root does not by itself indicate a provider fault.
The provider cannot add membership or raise the account's role.

### 8.5 Google Drive reports access denied or unavailable

Check whether the item was removed, moved to trash, unshared, or changed by
another user. Then check the selected account's Drive role and the destination
folder's permissions. A shortcut target can also become unavailable while the
shortcut remains visible.

Repeat the operation only after checking the actual Drive state. A failed client
response does not prove that a preceding mutation made no change.

### 8.6 Upload stalls, times out, or is rate-limited

1. Check client connectivity and proxy logs for the three Google hosts.
2. Check whether required methods or upload headers are blocked.
3. Compare the proxy timeout with the five-minute per-request deadline.
4. Check the first [GDRVFS] error code and HTTP status.
5. Wait before retrying when Google returns a rate-limit response.
6. Inspect Drive for a completed or partial result before repeating a write.

The provider retries safe reads and explicit rate-limit rejections within
bounded delays. It does not blindly repeat a write after an unknown network
outcome.

### 8.7 A Google Workspace file cannot be exported

Check the selected export format and whether Google offers that format for the
file type. Google's
[files.export endpoint](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export)
cannot return exported content larger than 10 MB. For a larger document, use
Google Drive's own download or export workflow instead.

### 8.8 Remote changes are not visible

1. Wait at least one five-minute polling interval.
2. Refresh or reopen the consumer's picker.
3. Confirm the account still has a current VFS connection.
4. Check that Thunderbird alarms are not disabled by a damaged profile.
5. Enable diagnostic logging and look for drive.changes.poll entries.

### 8.9 An account cannot be removed

The account is still bound to one or more VFS connections. Revoke every listed
connection for that account, then select **Sign out and remove** again.

### 8.10 Remote revocation could not be confirmed

The local account has already been removed. Open the user's
[Google Account connections](https://myaccount.google.com/connections), select
the application, and remove its access. Then verify that the account no longer
appears in the provider options.

## 9. Logging and support data

Diagnostic logging is disabled by default.

1. Open the provider options.
2. Enable **Enable diagnostic logging** and save the preferences.
3. Open Thunderbird's Error Console.
4. Reproduce the problem once.
5. Filter for **[GDRVFS]**.
6. Save only the relevant sequence, then disable diagnostic logging.

Collect:

- Thunderbird version;
- provider and consumer add-on versions;
- approximate operation time;
- Google account type: consumer or Workspace;
- OAuth mode and source: built-in or custom, local or managed, without copying
  the client ID or secret;
- whether My Drive or a Shared Drive was involved;
- operation and phase;
- stable error code and numeric HTTP status; and
- matching proxy or Google Workspace audit event, when available.

The provider removes tokens, authorization data, account and storage
identifiers, names, paths, addresses, request URLs, request bodies, file
content, and free-text exception messages from its own entries. Other
Thunderbird or add-on output may contain more information. Review every log
before sharing it.

The provider has no remote telemetry or monitoring endpoint. Operational
monitoring therefore comes from Thunderbird support logs, endpoint monitoring,
Google Workspace audit data, and reports from the consuming add-on.

Data handling is described in [PRIVACY.md](../PRIVACY.md).

## 10. Backup, recovery, and offboarding

### 10.1 Backup

The provider has no separate server-side database. Its operational state is in
the Thunderbird profile, while files remain in Google Drive.

Before an update:

1. Retain the approved XPI and its version.
2. Close Thunderbird.
3. Back up the complete Thunderbird profile through the organization's normal
   endpoint backup process.
4. Protect the backup as credential-bearing data because it can contain OAuth
   refresh tokens and a locally saved custom OAuth client pair.
5. Record which add-on version matches the backup.

### 10.2 Recovery

1. Install the provider version that matches the backup.
2. Restore the profile while Thunderbird is closed.
3. Start Thunderbird.
4. Confirm that the effective OAuth configuration matches the intended restored
   environment. Managed policy is deployed separately from the profile backup.
5. Check every configured account and VFS connection.
6. Use **Sign in again** if Google no longer accepts a restored grant or the
   effective client ID changed.
7. Run [Operational checks](#7-operational-checks).

Restoring a profile does not restore Drive content that Google has already
deleted or changed. Use Google Drive's own trash, retention, and recovery tools
for server-side content.

### 10.3 Offboarding

To remove access completely:

1. Revoke every consumer connection in the provider options.
2. Use **Sign out and remove** for every Google account.
3. Remove any remaining grant from the user's
   [Google Account connections](https://myaccount.google.com/connections).
4. Remove the add-on from Thunderbird.
5. Remove its `3rdparty.Extensions` OAuth policy when it is no longer required,
   then restart Thunderbird before reusing the profile for another deployment.
6. Retire profile and policy backups according to the organization's credential-retention
   policy.

Removing the add-on or a VFS connection does not delete Drive files. Items
previously moved to trash remain subject to Google Drive's retention and
permanent-deletion rules.
