import type { Metadata } from "next";
import { Rosarivo, Rufina, DM_Sans } from "next/font/google";
import "./globals.css";

const editorial = Rufina({weight: ["400", "700"], subsets: ["latin"], variable: "--font-editorial", display: "swap", fallback: ["Georgia", "Times New Roman", "serif"]});
const webhooks = Rosarivo({weight: "400", subsets: ["latin"], variable: "--font-webhooks", display: "swap", fallback: ["Georgia", "Times New Roman", "serif"]});
const ui = DM_Sans({subsets: ["latin"], variable: "--font-ui", display: "swap", fallback: ["Arial", "sans-serif"]});

export const metadata: Metadata = {
  title: "Waybill | Webhooks, that actually arrive.",
  description: "Track, inspect and recover webhook deliveries without the guesswork. An open-source webhook delivery platform.",
};

export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="en" className={`${editorial.variable} ${webhooks.variable} ${ui.variable}`}><body>{children}</body></html>;
}
