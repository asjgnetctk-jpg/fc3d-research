import { NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const STATIC_DATA_URL =
  "https://asjgnetctk-jpg.github.io/fc3d-research/data.json";

export async function GET() {
  try {
    const response = await fetch(`${STATIC_DATA_URL}?t=${Date.now()}`, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "User-Agent": "FC3DResearch/Sites-proxy",
      },
    });
    if (!response.ok) {
      throw new Error(`static-data-${response.status}`);
    }
    const payload = await response.json();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    console.error("recommendation-api", error);
    return NextResponse.json(
      { error: "暂时无法读取已核验数据，请稍后刷新。" },
      { status: 503 },
    );
  }
}
