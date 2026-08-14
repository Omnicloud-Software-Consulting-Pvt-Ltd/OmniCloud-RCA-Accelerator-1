"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Ic, tokens } from "@/components/data/quotes/shared";
import type { SalesforceSuccessInput } from "./SalesforceSuccessContext";

const ACCENT = "#00C875";

function ExternalLinkButton({ label, url, compact }: { label: string; url: string; compact?: boolean }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none",
        padding: compact ? "5px 10px" : "7px 14px", borderRadius: 9, fontSize: compact ? 11.5 : 12.5, fontWeight: 700,
        background: compact ? "transparent" : `linear-gradient(135deg, ${ACCENT}, #00A65E)`,
        color: compact ? ACCENT : "#04140B",
        border: compact ? `1px solid ${ACCENT}50` : "none",
      }}
    >
      {label} <Ic n="external-link" s={compact ? 11 : 12} />
    </a>
  );
}

export default function SalesforceSuccessCard({ isDark, notification, onClose }: {
  isDark: boolean;
  notification: SalesforceSuccessInput;
  onClose: () => void;
}) {
  const t = tokens(isDark);
  const [showDetails, setShowDetails] = useState(false);
  const { title, message, records, failedRecords = [], detailsLabel = "View Details" } = notification;
  const isBulk = records.length + failedRecords.length > 1;

  return (
    <motion.div
      initial={{ opacity: 0, x: 24, scale: 0.97 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.97 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      style={{
        pointerEvents: "auto",
        background: "rgba(1,9,24,0.94)",
        border: `1px solid ${ACCENT}40`,
        boxShadow: `0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px ${ACCENT}14`,
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderRadius: 14,
        padding: 14,
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${ACCENT}18`, color: ACCENT, border: `1px solid ${ACCENT}30` }}
        >
          <Ic n="check-circle" s={17} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-bold" style={{ color: isDark ? "white" : "#001F5B" }}>{title}</p>
          <p className="text-[12px] mt-1 leading-relaxed" style={{ color: isDark ? "rgba(180,205,235,0.85)" : "rgba(0,25,80,0.82)" }}>{message}</p>
        </div>
        <button onClick={onClose} style={{ color: t.dim, background: "transparent", border: "none", cursor: "pointer", flexShrink: 0 }}>
          <Ic n="x" s={13} />
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap mt-3" style={{ marginLeft: 44 }}>
        {!isBulk && records[0] && (
          <ExternalLinkButton label="View in Salesforce" url={records[0].salesforceUrl} />
        )}
        {isBulk && (
          <button
            onClick={() => setShowDetails(v => !v)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 9, fontSize: 11.5, fontWeight: 700,
              background: `linear-gradient(135deg, ${ACCENT}, #00A65E)`, color: "#04140B", border: "none", cursor: "pointer",
            }}
          >
            {showDetails ? "Hide Details" : detailsLabel}
            <Ic n={showDetails ? "chevron-down" : "chevron-right"} s={11} />
          </button>
        )}
      </div>

      <AnimatePresence>
        {isBulk && showDetails && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            style={{ marginLeft: 44, marginTop: 10, overflow: "hidden" }}
          >
            <div className="flex flex-col gap-1.5" style={{ maxHeight: 220, overflowY: "auto" }}>
              {records.map(r => (
                <div
                  key={`${r.objectApiName}-${r.recordId}`}
                  className="flex items-center gap-2"
                  style={{ padding: "5px 8px", borderRadius: 8, background: isDark ? "rgba(0,200,120,0.06)" : "rgba(0,200,120,0.08)" }}
                >
                  <span style={{ color: ACCENT, flexShrink: 0 }}><Ic n="check-circle" s={12} /></span>
                  <span className="text-[11.5px] font-medium flex-1 truncate" style={{ color: t.heading }}>{r.recordName}</span>
                  <ExternalLinkButton label="View" url={r.salesforceUrl} compact />
                </div>
              ))}
              {failedRecords.map((f, i) => (
                <div
                  key={`failed-${i}`}
                  className="flex items-start gap-2"
                  style={{ padding: "5px 8px", borderRadius: 8, background: isDark ? "rgba(255,64,102,0.06)" : "rgba(255,64,102,0.08)" }}
                >
                  <span style={{ color: t.error, flexShrink: 0, marginTop: 1 }}><Ic n="alert" s={12} /></span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11.5px] font-medium truncate" style={{ color: t.heading }}>{f.recordName}</div>
                    <div className="text-[11px]" style={{ color: t.error }}>{f.error}</div>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
