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
  title: "Omnicloud AI Platform",
  description:
    "Enterprise-grade AI platform for Salesforce Revenue Cloud. Powered by Omnion AI.",
  keywords: ["Omnicloud", "AI", "Salesforce", "Revenue Cloud", "Enterprise", "CPQ"],
  authors: [{ name: "OmniCloud Software Consulting" }],
  icons: {
    icon: [{ url: "/favicon.ico", sizes: "any" }],
    shortcut: "/favicon.ico",
    apple: "/favicon.ico",
  },
  applicationName: "Omnicloud AI Platform",
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
