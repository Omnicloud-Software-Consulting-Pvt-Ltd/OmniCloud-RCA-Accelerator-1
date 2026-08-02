"use client";

import { useEffect, useRef, useState } from "react";
import { Ic, tokens } from "@/components/data/quotes/shared";

/** Every merge field the Template Studio's toolbar can insert (§Center Panel "Dynamic merge fields"). */
export const MERGE_FIELDS = [
  "CompanyName", "CustomerName", "ContractNumber", "StartDate", "EndDate",
  "Status", "Owner", "QuoteNumber", "AccountName", "Products", "GrandTotal",
  "BillingFrequency", "PaymentTerms", "AuthorizedSigner",
];

function ToolbarButton({ icon, text, label, isDark, onClick, active }: { icon?: string; text?: string; label: string; isDark: boolean; onClick: () => void; active?: boolean }) {
  const t = tokens(isDark);
  return (
    <button
      type="button"
      title={label}
      onMouseDown={e => e.preventDefault()} // keep the editor's own selection focused — a normal button click steals it first
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", minWidth: 30, height: 30, padding: text ? "0 8px" : 0, borderRadius: 7,
        border: `1px solid ${active ? t.accent + "60" : t.border}`, background: active ? `${t.accent}18` : "transparent",
        color: active ? t.accent : t.body, cursor: "pointer", fontSize: 12, fontWeight: 700,
      }}
    >
      {icon ? <Ic n={icon} s={14} /> : text}
    </button>
  );
}

/**
 * Rich document editor (§Center Panel) — a contentEditable surface with a
 * formatting toolbar built on the browser's own `document.execCommand`
 * (headings/bold/italic/lists), plus custom insert commands this app builds
 * itself (tables, images, page breaks, merge fields) via `insertHTML`. This
 * is a deliberately lighter-weight choice than a full editor framework
 * (TipTap/Slate/ProseMirror aren't dependencies here) — it covers every
 * format the Studio's own PDF/DOCX renderers understand
 * (pdfTagConverter.ts's recognized tag set) and nothing it can't also export.
 */
export default function RichTextEditor({ isDark, value, onChange, disabled }: {
  isDark: boolean;
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
}) {
  const t = tokens(isDark);
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mergeMenuOpen, setMergeMenuOpen] = useState(false);

  // Only reset the DOM when `value` genuinely changed from OUTSIDE this editor
  // (template switch, restore version) — our own onChange already leaves
  // innerHTML equal to `value`, so this never fights the user's cursor mid-type.
  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = value;
    }
  }, [value]);

  function handleInput() {
    if (editorRef.current) onChange(editorRef.current.innerHTML);
  }

  function focusEditor() {
    editorRef.current?.focus();
  }

  function exec(command: string, arg?: string) {
    focusEditor();
    document.execCommand(command, false, arg);
    handleInput();
  }

  function insertMergeField(field: string) {
    focusEditor();
    document.execCommand(
      "insertHTML", false,
      `<span class="merge-field" style="background:${t.accent}22;color:${t.accent};padding:1px 5px;border-radius:5px;font-weight:600;white-space:nowrap;">{{${field}}}</span>&nbsp;`,
    );
    handleInput();
    setMergeMenuOpen(false);
  }

  function insertTable() {
    focusEditor();
    const html = "<table><tr><th>Header 1</th><th>Header 2</th></tr><tr><td>Cell</td><td>Cell</td></tr></table><p><br/></p>";
    document.execCommand("insertHTML", false, html);
    handleInput();
  }

  function insertPageBreak() {
    focusEditor();
    document.execCommand("insertHTML", false, `<hr class="pdf-pagebreak" style="border:none;border-top:2px dashed ${t.dim};margin:18px 0;" /><p><br/></p>`);
    handleInput();
  }

  function handleImageFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      focusEditor();
      document.execCommand("insertImage", false, reader.result as string);
      handleInput();
    };
    reader.readAsDataURL(file);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 6, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt, position: "relative" }}>
        <ToolbarButton text="¶" label="Paragraph" isDark={isDark} onClick={() => exec("formatBlock", "P")} />
        <ToolbarButton text="H1" label="Heading 1" isDark={isDark} onClick={() => exec("formatBlock", "H1")} />
        <ToolbarButton text="H2" label="Heading 2" isDark={isDark} onClick={() => exec("formatBlock", "H2")} />
        <ToolbarButton text="H3" label="Heading 3" isDark={isDark} onClick={() => exec("formatBlock", "H3")} />
        <div style={{ width: 1, background: t.border, margin: "2px 4px" }} />
        <ToolbarButton text="B" label="Bold" isDark={isDark} onClick={() => exec("bold")} />
        <ToolbarButton text="I" label="Italic" isDark={isDark} onClick={() => exec("italic")} />
        <div style={{ width: 1, background: t.border, margin: "2px 4px" }} />
        <ToolbarButton icon="list" label="Bullet List" isDark={isDark} onClick={() => exec("insertUnorderedList")} />
        <ToolbarButton text="1." label="Numbered List" isDark={isDark} onClick={() => exec("insertOrderedList")} />
        <div style={{ width: 1, background: t.border, margin: "2px 4px" }} />
        <ToolbarButton icon="table" label="Insert Table" isDark={isDark} onClick={insertTable} />
        <ToolbarButton icon="image" label="Insert Image" isDark={isDark} onClick={() => fileInputRef.current?.click()} />
        <ToolbarButton icon="minimize" label="Page Break" isDark={isDark} onClick={insertPageBreak} />
        <div style={{ width: 1, background: t.border, margin: "2px 4px" }} />
        <ToolbarButton icon="refresh" label="Undo" isDark={isDark} onClick={() => exec("undo")} />
        <ToolbarButton icon="arrow-right" label="Redo" isDark={isDark} onClick={() => exec("redo")} />
        <div style={{ width: 1, background: t.border, margin: "2px 4px" }} />
        <div style={{ position: "relative" }}>
          <button
            type="button"
            onMouseDown={e => e.preventDefault()}
            onClick={() => setMergeMenuOpen(v => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 5, padding: "0 10px", height: 30, borderRadius: 7, border: `1px solid ${t.accent}50`,
              background: `${t.accent}14`, color: t.accent, cursor: "pointer", fontSize: 11.5, fontWeight: 700,
            }}
          >
            <Ic n="sparkles" s={13} /> Merge Field
          </button>
          {mergeMenuOpen && (
            <div style={{ position: "absolute", zIndex: 30, top: "100%", left: 0, marginTop: 4, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surface, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", maxHeight: 260, overflowY: "auto", minWidth: 200 }}>
              {MERGE_FIELDS.map(f => (
                <button
                  key={f}
                  type="button"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => insertMergeField(f)}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 12px", border: "none", background: "transparent", cursor: "pointer", fontSize: 12, color: t.body, fontFamily: "ui-monospace, monospace" }}
                >
                  {"{{" + f + "}}"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) handleImageFile(f); e.target.value = ""; }} />

      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={handleInput}
        onBlur={handleInput}
        className="rich-text-editor-surface"
        style={{
          minHeight: 440, padding: "28px 32px", borderRadius: 10, border: `1px solid ${t.border}`,
          background: "#ffffff", color: "#1a1a1a", outline: "none", overflowY: "auto", maxHeight: 640,
          fontFamily: "Helvetica, Arial, sans-serif", fontSize: 13, lineHeight: 1.6,
        }}
      />
    </div>
  );
}
