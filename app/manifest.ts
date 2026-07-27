import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "福彩3D私人研究台",
    short_name: "3D研究台",
    description: "固定公式生成独胆与7码，逐期核对推荐和开奖。",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f0e6",
    theme_color: "#163f31",
    lang: "zh-CN",
  };
}
