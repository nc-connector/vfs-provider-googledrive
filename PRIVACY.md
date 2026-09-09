# Privacy Policy — VFS Provider for Google Drive

Last updated: September 9, 2026

This policy describes how VFS Provider for Google Drive handles data when it
connects Google Drive storage to compatible Thunderbird add-ons. The provider
does not operate a developer-owned server and does not send telemetry.

## 1. User choice and scope

No Google authorization starts when the add-on is installed, when Thunderbird
starts, or when the settings page is merely opened. The user starts the process
by selecting **Add account** after the settings page describes the requested
Drive access.

A compatible VFS consumer receives access only after the user opens the
provider's connection setup, reviews the requesting add-on's name and ID,
selects a Google account, and grants the connection. Each connection is limited
to that consumer add-on and selected account.

## 2. Data handled by the provider

The provider handles the following data to supply its requested features:

- Google account identifiers, display name, and email address;
- OAuth authorization codes, access tokens, refresh tokens, token expiry, and
  the OAuth client ID used for the grant;
- Google Drive file and folder identifiers, names, types, sizes, timestamps,
  permissions, hierarchy, quota, Shared Drive membership, and change records;
- file content uploaded to or downloaded from Google Drive, including exported
  Google Workspace documents;
- VFS connection storage IDs, the chosen account binding, connection name,
  requesting add-on name and ID, and granted capabilities; and
- local preferences such as export formats and diagnostic logging status.

The provider does not request or read Thunderbird mail, address books,
calendars, browsing history, or passwords.

## 3. Data transmission and sharing

The provider communicates directly with Google's HTTPS services:

- `accounts.google.com` displays Google's authorization and consent page;
- `oauth2.googleapis.com` exchanges, refreshes, and revokes OAuth tokens; and
- `www.googleapis.com` supplies the Google Drive API and upload service.

Google receives the OAuth and Drive request data needed to perform the action.
Google's handling of that data is governed by the user's Google relationship
and Google's privacy terms.

After the user grants a VFS connection, the named consumer add-on can request
the permitted Drive operations. Downloaded file content and metadata are
returned locally to that consumer. Content supplied by the consumer for an
upload is sent to Google Drive. Consumer add-ons are separate products and may
have their own privacy terms; users should grant connections only to add-ons
they trust.

For accounts with an active VFS connection, the provider polls Google Drive
change logs every five minutes. Polling transfers account and Drive identifiers
needed to check for changes. When a change is detected, the provider tells each
authorized local consumer to refresh its storage view; it does not send Drive
content to a developer-operated service.

No data is sold, used for advertising, or shared for analytics. The provider
does not include third-party tracking or remote diagnostic reporting.

VFS Provider for Google Drive's use of information received from Google APIs
will adhere to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## 4. Local storage and retention

Thunderbird extension storage holds:

- account identifiers, display name, email address, account status, OAuth
  client ID, and refresh token in `storage.local`;
- VFS account bindings, Drive change cursors, and provider preferences in
  `storage.local`; and
- short-lived access tokens and unfinished OAuth transaction data in
  `storage.session`.

The VFS Toolkit also stores consumer connection records in the Thunderbird
profile. These records identify the consumer, storage, connection name, API
version, and capabilities. File content is transferred in memory and is not
intentionally cached by this provider on disk.

Local records remain until the account or add-on is removed. Thunderbird
profile backups can retain older copies. Removing an unused account from the
settings asks Google to revoke its grant and removes the local account data. If
Google cannot confirm revocation, the local record is still removed and the
provider displays a warning. The user can separately revoke the grant in their
Google Account.

The provider settings list the add-ons with a current VFS connection. Revoking
one connection removes that add-on's access record and the local account
binding for the connection. It does not remove the Google account, revoke its
Google grant, or delete files from Google Drive.

Removing the add-on removes its active local extension storage according to
Thunderbird's add-on behavior, but it does not delete files from Google Drive
and might not revoke the Google grant. Revoke the grant in the Google Account
when access should end completely.

## 5. Deletion behavior

A VFS delete request moves the selected Google Drive item to the recoverable
Google Drive trash. The provider does not permanently delete Drive content.
Google Drive retention, trash, restoration, and permanent deletion rules apply
after that operation.

## 6. Diagnostics

Diagnostic logging is disabled by default. When the user enables it, logs stay
in Thunderbird's local developer console. The provider records operation
phases, status, and stable error categories. It removes tokens, authorization
data, account and storage identifiers, names, paths, addresses, request URLs,
request bodies, file content, and free-text error messages from its own log
entries.

Before sharing a diagnostic log, users should still review it for information
written by Thunderbird, a consumer add-on, Google, or another component.

## 7. Security

OAuth uses the Authorization Code flow with PKCE. The publisher's Google
Desktop OAuth client configuration is supplied as an external release-build
input and is included in the distributed add-on. Installed applications cannot
keep this public client configuration confidential, so it is not used as a
security boundary or as proof that a request came from an untampered add-on.
It is not a user credential and is not copied into account records or logs.
Sensitive network requests use HTTPS. Host permissions are limited to Google's
OAuth and Drive API hosts. Packaged code is self-contained; the add-on does not
download code for execution.

Refresh tokens are stored in the Thunderbird profile rather than an operating
system credential vault. Device access and Thunderbird profile backups must
therefore be protected by the user or administrator.

## 8. Changes and contact

Material changes to data handling will be described in the release notes and
reflected in this policy before the changed version is released.

Questions or privacy reports can be filed in the project's
[issue tracker](https://github.com/nc-connector/vfs-provider-googledrive/issues).
