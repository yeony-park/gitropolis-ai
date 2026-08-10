import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Gitropolis — GitHub AI Ecosystem City",
  description: "Explore momentum across the GitHub AI ecosystem as an interactive 3D city.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
