import type { Metadata } from "next";
import { Inter, Playfair_Display } from "next/font/google";
import "./globals.css";
import { DemoToggleWrapper } from "@/components/shared/demo-toggle-wrapper";
import { ToastProvider } from "@/components/ui/toast";
import { legacyDemoRoutesEnabled } from "@/lib/http/legacy-demo-route";

const inter = Inter({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const playfair = Playfair_Display({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "700"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://team-floww.vercel.app"),
  title: "TeamFlow — Cocoa Bakery Hiring",
  description: "Hire the right baristas, bakers, and shift supervisors for Cocoa Bakery in Jersey City with AI-assisted résumé review and candidate tracking.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/" },
  openGraph: {
    title: "TeamFlow — Cocoa Bakery Hiring",
    description: "A warm, focused hiring workspace for Cocoa Bakery in Jersey City.",
    type: "website",
    url: "/",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "TeamFlow — Cocoa Bakery hiring workspace",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "TeamFlow — Cocoa Bakery Hiring",
    description: "A warm, focused hiring workspace for Cocoa Bakery in Jersey City.",
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
        className={`${inter.variable} ${playfair.variable} font-sans antialiased`}
      >
        <ToastProvider>
          {children}
        </ToastProvider>
        {legacyDemoRoutesEnabled() ? <DemoToggleWrapper /> : null}
      </body>
    </html>
  );
}
