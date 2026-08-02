"use client";

import Image from "next/image";

/**
 * Co-branded lockup: Omnicloud logo · divider · Salesforce Partner badge.
 * Matches the omnicloudconsulting.com brand bar. Theme-aware — uses the
 * white-text Omnicloud logo on dark and the dark-text version on light.
 */
export function BrandLockup({
  isDark,
  height = 38,
  className = "",
}: {
  isDark: boolean;
  height?: number;
  className?: string;
}) {
  const sfHeight = Math.round(height * 0.8);
  return (
    <div className={`flex items-center justify-center gap-4 ${className}`}>
      <Image
        src={isDark ? "/logo-ondark.png" : "/omnicloud_transparent.png"}
        alt="Omnicloud — Aspire. Inspire. Perspire."
        width={1172}
        height={400}
        style={{ height, width: "auto", objectFit: "contain" }}
        priority
      />
      <div
        style={{
          width: 1,
          height: Math.round(height * 0.85),
          background: isDark ? "rgba(255,255,255,0.22)" : "rgba(0,31,91,0.2)",
        }}
      />
      <Image
        src="/salesforce-partner-wide.png"
        alt="Salesforce Partner"
        width={1600}
        height={771}
        style={{ height: sfHeight, width: "auto", objectFit: "contain" }}
      />
    </div>
  );
}
