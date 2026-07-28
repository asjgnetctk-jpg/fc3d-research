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
    description: "V6独立盲测公式生成独胆、7码与组三/组六二选一，逐期记录推荐、开奖和连续未中状态。",
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
      description: "独胆 · 7码 · 形态二选一 · 五年独立盲测",
      images: [{ url: imageUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "福彩3D 私人研究台",
      description: "独胆 · 7码 · 形态二选一 · 五年独立盲测",
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
