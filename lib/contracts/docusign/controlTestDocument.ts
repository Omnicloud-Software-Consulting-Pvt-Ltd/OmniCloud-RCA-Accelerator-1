import React from "react";
import { Document, Page, Text, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 12 },
  title: { fontSize: 18, fontWeight: 700, marginBottom: 16 },
  body: { marginBottom: 8 },
});

/**
 * A trivial, self-contained one-page PDF for the DocuSign Settings "Send
 * Test Envelope" control test (§ email-delivery diagnostics). Deliberately
 * NOT part of lib/contracts/documents/pdf.ts's contract-generation pipeline
 * — this test document has no Contract, template, or branding behind it, it
 * exists only to exercise the real createAndSendEnvelope() call end-to-end.
 */
export async function renderControlTestDocument(): Promise<Buffer> {
  const doc = React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "LETTER", style: styles.page },
      React.createElement(Text, { style: styles.title }, "DocuSign Connectivity Test"),
      React.createElement(Text, { style: styles.body }, "This is a one-off test document sent to verify DocuSign email delivery for this connection."),
      React.createElement(Text, { style: styles.body }, "It is not associated with any Contract. No signature is required — you may safely ignore or decline it."),
    ),
  );
  return renderToBuffer(doc as Parameters<typeof renderToBuffer>[0]);
}
