import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { DemoToggleWrapper } from "@/components/shared/demo-toggle-wrapper";
import { ToastProvider } from "@/components/ui/toast";
import { legacyDemoRoutesEnabled } from "@/lib/http/legacy-demo-route";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://team-floww.vercel.app"),
  title: "TeamFlow — Simple Hiring for Small Teams",
  description: "A bakery-owner hiring workspace that turns a plain-language need into a reviewable candidate list with visible résumé evidence.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "TeamFlow — Simple Hiring for Small Teams",
    description: "Describe the shift you need to fill and review the fictional résumé evidence behind every result.",
    type: "website",
    url: "/",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "TeamFlow — Simple hiring help for small teams — Cocoa Bakery demo workspace",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "TeamFlow — Simple Hiring for Small Teams",
    description: "Describe the shift you need to fill and review the fictional résumé evidence behind every result.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
      >
        <ToastProvider>
          {children}
        </ToastProvider>
        {legacyDemoRoutesEnabled() ? <DemoToggleWrapper /> : null}
      </body>
    </html>
  );
}
