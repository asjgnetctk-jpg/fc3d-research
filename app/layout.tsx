import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "sites.openai.com";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const imageUrl = new URL("/og.png", base).toString();

  return {
    metadataBase: base,
    title: "福彩3D私人研究台",
    description: "V7逐期滚动计算独胆、5码、6码、7码与组三概率，分项展示全部战绩和最长连续未中。",
    applicationName: "福彩3D研究台",
    appleWebApp: {
      capable: true,
      title: "3D研究台",
      statusBarStyle: "black-translucent",
    },
    formatDetection: {
      telephone: false,
    },
    openGraph: {
      title: "福彩3D 私人研究台",
      description: "独胆 · 5码 · 6码 · 7码 · 组三概率",
      images: [{ url: imageUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "福彩3D 私人研究台",
      description: "独胆 · 5码 · 6码 · 7码 · 组三概率",
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
