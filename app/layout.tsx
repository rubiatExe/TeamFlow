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
  title: "TeamFlow — Evidence-Grounded Candidate Search",
  description: "A production-deployed, synthetic-only demonstration of semantic candidate retrieval with visible source citations and human review.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "TeamFlow — Evidence-Grounded Candidate Search",
    description: "Describe job-relevant experience and inspect the synthetic résumé evidence behind every semantic match.",
    type: "website",
    url: "/",
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
