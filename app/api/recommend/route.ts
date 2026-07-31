import { NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const STATIC_DATA_ROOT =
  "https://asjgnetctk-jpg.github.io/fc3d-research";

export async function GET(request: Request) {
  try {
    const game =
      new URL(request.url).searchParams.get("game") === "pl3" ? "pl3" : "fc3d";
    const file = game === "pl3" ? "pl3-data.json" : "data.json";
    const response = await fetch(`${STATIC_DATA_ROOT}/${file}?t=${Date.now()}`, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "User-Agent": "ThreeDigitResearch/Sites-proxy",
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
