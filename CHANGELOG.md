# Changelog

This file records user-visible changes for each release.

## Unreleased

### Added

- Thunderbird Manifest V3 provider for account-bound Google Drive storage
  through VFS Toolkit API 1.3.
- Browsing and file access for My Drive, Shared with me, and Shared Drives.
- Binary downloads and configurable Google Docs, Sheets, Slides, and Drawings
  exports.
- File uploads and replacements using multipart or resumable transfer according
  to file size.
- Folder creation, moves, server-side file copies, recursive folder copies,
  folder merges, and recoverable removal through the Google Drive trash.
- Multiple Google accounts with OAuth 2.0 PKCE, token refresh, reauthorization,
  and account-bound VFS connections.
- Request progress, cancellation, bounded retry, storage quota reporting, and
  periodic remote-change updates.
- Localized settings and connection pages in all supported project languages.

### Security and review

- Restricted Google API host permissions and no remotely executed code.
- Redacted diagnostics that omit credentials, identifiers, paths, file names,
  request URLs, and file content.
- Reproducible XPI packaging with a checked file allowlist and pinned,
  hash-verified Thunderbird VFS Toolkit sources.
