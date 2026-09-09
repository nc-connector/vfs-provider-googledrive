# Changelog

All notable changes to **VFS-Provider: Google Drive** will be documented in
this file.

This project supports **Thunderbird 140 and newer**.

## 0.1.0-rc.1

### Added

- First release candidate of a Manifest V3 Google Drive storage provider for
  Thunderbird add-ons using VFS Toolkit API 1.3.
- Google OAuth Authorization Code flow with PKCE, refresh-token handling,
  reauthorization, revocation, and support for multiple Google accounts.
- A built-in OAuth client for normal installations, optional custom Google
  Desktop OAuth credentials, and administrator-controlled OAuth configuration
  through Thunderbird managed policy.
- Account-bound VFS connections that can be shared by multiple consuming
  add-ons and revoked individually without removing the Google account or its
  Drive files.
- Browsing and file access for My Drive, Shared with me, Shared Drives,
  shortcuts, duplicate names, and link-shared items with resource keys.
- Binary and Google Workspace downloads with selectable DOCX, XLSX, PPTX, or
  PDF export formats where supported by Google Drive.
- File creation and replacement, recursive folder creation, metadata-based
  moves, server-side copies, folder merges, and recoverable deletion through
  the Google Drive trash.
- Multipart and resumable uploads, progress reporting, cancellation, bounded
  retries, request deadlines, storage-quota reporting, and periodic Drive
  change notifications.
- Localized account, connection, export, diagnostic, and OAuth configuration
  interfaces in all supported project languages.
- Administration, development, privacy, translation, licensing, and vendored
  source documentation for deployment and review.
- Privacy-focused diagnostic logging that excludes OAuth credentials, tokens,
  authorization data, paths, file names, request URLs, and file content.
- Restricted Google OAuth and Drive API host access without remotely hosted
  code.
- Reproducible release packaging that injects the external Desktop OAuth client
  only into the packaged module without copying its credential JSON into the
  XPI or repository.
- Pinned, hash-verified Thunderbird VFS Toolkit sources with recorded upstream
  locations and license information.
