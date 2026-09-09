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

An unmanaged profile can use the OAuth client included with the add-on or an
OAuth client configured locally by the user. An administrator can use
Thunderbird managed storage to force the included client or an
organization-provided client. A managed choice is read-only in the add-on.
Choosing or changing the OAuth client does not grant Drive access and does not
remove the requirement for the user's interactive Google sign-in and consent.

A compatible VFS consumer receives access only after the user opens the
provider's connection setup, reviews the requesting add-on's name and ID,
selects a Google account, and grants the connection. Each connection is limited
to that consumer add-on and selected account.

## 2. Data handled by the provider

The provider handles the following data to supply its requested features:

- Google account identifiers, display name, and email address;
- OAuth authorization codes, access tokens, refresh tokens, token expiry, and
  the OAuth client ID used for the grant;
- the selected OAuth mode and source and, when a custom Google Desktop client is
  configured, its client ID and client secret;
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

- `accounts.google.com` displays Google's authorization and consent page and
  receives the effective OAuth client ID;
- `oauth2.googleapis.com` receives the effective OAuth client ID and client
  secret for token exchange and refresh, and receives a token when revocation
  is requested; and
- `www.googleapis.com` supplies the Google Drive API and upload service.

Google receives the OAuth and Drive request data needed to perform the action.
Google's handling of that data is governed by the user's Google relationship
and Google's privacy terms.

Locally configured and administrator-managed client IDs and secrets are used
only for direct requests to Google's OAuth services. They are not sent to a
developer-operated service, a VFS consumer add-on, or an analytics service.

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
  `storage.local`;
- the local OAuth configuration in `storage.local`, including a custom client
  ID and client secret when the user has saved them; and
- short-lived access tokens and unfinished OAuth transaction data in
  `storage.session`.

The built-in client configuration is part of the installed add-on. A managed
OAuth configuration is read from Thunderbird's read-only `storage.managed`
area and is not copied into the local OAuth configuration. The add-on's runtime
message interface returns the effective mode, source, client ID, lock status,
and whether a client secret is present. For an unmanaged built-in mode, it also
returns a saved custom client ID and whether its dormant secret is present so
the settings page can switch modes without exposing the secret. It never returns
a client secret.

The VFS Toolkit also stores consumer connection records in the Thunderbird
profile. These records identify the consumer, storage, connection name, API
version, and capabilities. File content is transferred in memory and is not
intentionally cached by this provider on disk.

Account records remain until the account or add-on is removed. Provider
preferences and local OAuth configuration remain until they are replaced or the
add-on's local storage is removed. Thunderbird profile backups can retain older
copies. Removing an unused account from the settings asks Google to revoke its
grant and removes the local account data. If Google cannot confirm revocation,
the local record is still removed and the provider displays a warning. The user
can separately revoke the grant in their Google Account.

The provider settings list the add-ons with a current VFS connection. Revoking
one connection removes that add-on's access record and the local account
binding for the connection. It does not remove the Google account, revoke its
Google grant, or delete files from Google Drive.

Removing the add-on removes its active local extension storage according to
Thunderbird's add-on behavior, but it does not delete files from Google Drive
and might not revoke the Google grant. Revoke the grant in the Google Account
when access should end completely.

A locally saved custom client pair remains in the profile until it is replaced
or the add-on's local storage is removed. Selecting the built-in mode can leave
that pair dormant so the user can select it again later. An administrator owns
the lifecycle and retention of values distributed through managed policy.
Changing the effective client ID keeps account records, VFS connection records,
and Drive files, but the affected accounts must be authorized again. The add-on
does not automatically revoke the previous Google grant when the client changes.

## 5. Deletion behavior

A VFS delete request moves the selected Google Drive item to the recoverable
Google Drive trash. The provider does not permanently delete Drive content.
Google Drive retention, trash, restoration, and permanent deletion rules apply
after that operation.

## 6. Diagnostics

Diagnostic logging is disabled by default. When the user enables it, logs stay
in Thunderbird's local developer console. The provider records operation
phases, status, and stable error categories. It removes tokens, authorization
data, OAuth client IDs and secrets, managed-policy values, account and storage
identifiers, names, paths, addresses, request URLs, request bodies, file
content, and free-text error messages from its own log entries.

Before sharing a diagnostic log, users should still review it for information
written by Thunderbird, a consumer add-on, Google, or another component.

## 7. Security

OAuth uses the Authorization Code flow with PKCE. The effective Google Desktop
OAuth client can be the publisher's built-in client, a locally saved client, or
an administrator-managed client. Desktop application client IDs and secrets
cannot be kept confidential in an installed client. They are application
configuration, not user credentials, and are not used as a security boundary
or as proof that a request came from an untampered add-on. PKCE protects the
authorization-code transaction.

The client ID is retained as authorization metadata for an account. The client
secret is used for token exchange and refresh but is not copied into account
records, access-token session records, runtime responses, or logs. A custom
secret can nevertheless be present in the Thunderbird profile or an enterprise
policy file, and the built-in secret is inspectable in the installed add-on.
Those locations should be protected against unauthorized modification and
unnecessary disclosure. Sensitive network requests use HTTPS. Host permissions
are limited to Google's OAuth and Drive API hosts. Packaged code is
self-contained; the add-on does not download code for execution.

Refresh tokens are stored in the Thunderbird profile rather than an operating
system credential vault. Device access and Thunderbird profile backups must
therefore be protected by the user or administrator.

## 8. Changes and contact

Material changes to data handling will be described in the release notes and
reflected in this policy before the changed version is released.

Questions or privacy reports can be filed in the project's
[issue tracker](https://github.com/nc-connector/vfs-provider-googledrive/issues).
