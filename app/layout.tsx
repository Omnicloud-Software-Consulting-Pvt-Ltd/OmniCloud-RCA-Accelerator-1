import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "OmniVerse — From Complexity. Into Clarity.",
  description:
    "OmniVerse — an Agentic Accelerator Platform by OmniCloud for Salesforce Revenue Cloud.",
  keywords: ["OmniVerse", "OmniCloud", "AI", "Agentic", "Salesforce", "Revenue Cloud", "Accelerator", "CPQ"],
  authors: [{ name: "OmniCloud Software Consulting" }],
  // Favicon is auto-detected from app/icon.png (the transparent Omnicloud mark).
  applicationName: "OmniVerse",
  creator: "OmniCloud Software Consulting",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)",  color: "#000508" },
    { media: "(prefers-color-scheme: light)", color: "#F5F8FF" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="min-h-dvh overflow-x-hidden antialiased">
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
