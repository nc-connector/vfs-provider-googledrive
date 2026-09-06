/**
 * Google Workspace export mapping tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  GOOGLE_WORKSPACE_MIME_TYPES,
  getWorkspaceExport,
  getWorkspaceKind,
  isGoogleWorkspaceFile
} from "../src/google/workspace-export.mjs";

const FORMATS = Object.freeze({
  document: "docx",
  spreadsheet: "xlsx",
  presentation: "pptx",
  drawing: "pdf"
});

test("maps every supported Workspace type to its configured export", () => {
  const cases = [
    ["document", "Report", ".docx"],
    ["spreadsheet", "Budget", ".xlsx"],
    ["presentation", "Roadmap", ".pptx"],
    ["drawing", "Diagram", ".pdf"]
  ];

  for (const [kind, name, extension] of cases) {
    const result = getWorkspaceExport({
      name,
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES[kind]
    }, FORMATS);

    assert.equal(result.kind, kind);
    assert.equal(result.name, `${name}${extension}`);
    assert.match(result.mimeType, /^(?:application\/pdf|application\/vnd\.openxmlformats)/);
  }
});

test("uses PDF when selected for Docs, Sheets, and Slides", () => {
  for (const kind of ["document", "spreadsheet", "presentation"]) {
    const result = getWorkspaceExport({
      name: "Example",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES[kind]
    }, {
      ...FORMATS,
      [kind]: "pdf"
    });

    assert.equal(result.name, "Example.pdf");
    assert.equal(result.mimeType, "application/pdf");
  }
});

test("does not append the selected extension twice", () => {
  const result = getWorkspaceExport({
    name: "Report.DOCX",
    mimeType: GOOGLE_WORKSPACE_MIME_TYPES.document
  }, FORMATS);

  assert.equal(result.name, "Report.DOCX");
});

test("leaves binary files outside the Workspace export mapping", () => {
  assert.equal(getWorkspaceKind("application/pdf"), null);
  assert.equal(isGoogleWorkspaceFile("application/pdf"), false);
  assert.equal(getWorkspaceExport({
    name: "report.pdf",
    mimeType: "application/pdf"
  }, FORMATS), null);
});

test("rejects a missing export choice for a supported Workspace type", () => {
  assert.throws(
    () => getWorkspaceExport({
      name: "Report",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.document
    }, {}),
    /Unsupported document export format/
  );
});
