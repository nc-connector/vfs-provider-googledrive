/**
 * Google Workspace export formats exposed as regular VFS files.
 */

"use strict";

export const GOOGLE_WORKSPACE_MIME_TYPES = Object.freeze({
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  drawing: "application/vnd.google-apps.drawing"
});

const EXPORT_TARGETS = Object.freeze({
  document: Object.freeze({
    docx: Object.freeze({
      extension: ".docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }),
    pdf: Object.freeze({
      extension: ".pdf",
      mimeType: "application/pdf"
    })
  }),
  spreadsheet: Object.freeze({
    xlsx: Object.freeze({
      extension: ".xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }),
    pdf: Object.freeze({
      extension: ".pdf",
      mimeType: "application/pdf"
    })
  }),
  presentation: Object.freeze({
    pptx: Object.freeze({
      extension: ".pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    }),
    pdf: Object.freeze({
      extension: ".pdf",
      mimeType: "application/pdf"
    })
  }),
  drawing: Object.freeze({
    pdf: Object.freeze({
      extension: ".pdf",
      mimeType: "application/pdf"
    })
  })
});

const KIND_BY_MIME_TYPE = new Map(
  Object.entries(GOOGLE_WORKSPACE_MIME_TYPES)
    .map(([kind, mimeType]) => [mimeType, kind])
);

function requireName(value) {
  if (typeof value !== "string" || !value) {
    throw new TypeError("name must be a non-empty string");
  }
  return value;
}

function exportedName(name, extension) {
  const sourceName = requireName(name);
  return sourceName.toLocaleLowerCase("en-US").endsWith(extension)
    ? sourceName
    : `${sourceName}${extension}`;
}

export function getWorkspaceKind(mimeType) {
  return KIND_BY_MIME_TYPE.get(mimeType) || null;
}

export function getWorkspaceExport(file, exportFormats) {
  const kind = getWorkspaceKind(file?.mimeType);
  if (!kind) {
    return null;
  }
  const format = exportFormats?.[kind];
  const target = EXPORT_TARGETS[kind]?.[format];
  if (!target) {
    throw new TypeError(`Unsupported ${kind} export format: ${format}`);
  }
  return {
    kind,
    format,
    mimeType: target.mimeType,
    extension: target.extension,
    name: exportedName(file.name, target.extension)
  };
}

export function isGoogleWorkspaceFile(mimeType) {
  return KIND_BY_MIME_TYPE.has(mimeType);
}
