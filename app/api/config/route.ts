import { NextRequest, NextResponse } from "next/server";
import {
  CONFIG_COOKIE,
  CONFIG_MAX_AGE,
  type AppConfig,
  encodeConfig,
  getConfig,
} from "@/lib/config";

/**
 * App configuration entered in the Setup wizard:
 *  - Anthropic API key (BYO, per user)
 *  - Salesforce Connected App Client ID + Secret (per user/browser)
 * Stored in an httpOnly cookie. Accepts partial updates (merges with existing).
 *
 * GET    → booleans only, never the secret values
 * POST   → save a subset of fields
 * DELETE → clear all config
 */

export async function GET(req: NextRequest) {
  const config = getConfig(req);
  return NextResponse.json({
    hasAnthropicKey: Boolean(config?.anthropicApiKey),
    hasConnectedApp: Boolean(config?.sfClientId && config?.sfClientSecret),
  });
}

export async function POST(req: NextRequest) {
  let body: { anthropicApiKey?: string; sfClientId?: string; sfClientSecret?: string } | null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const existing = getConfig(req) ?? {};
  const next: AppConfig = { ...existing };
  let touched = false;

  // Anthropic key
  if (body?.anthropicApiKey !== undefined) {
    const key = String(body.anthropicApiKey).trim();
    if (!key) {
      return NextResponse.json({ error: "Anthropic API key is required." }, { status: 400 });
    }
    if (!key.startsWith("sk-ant-")) {
      return NextResponse.json(
        { error: "That doesn't look like an Anthropic API key (expected to start with 'sk-ant-')." },
        { status: 400 },
      );
    }
    next.anthropicApiKey = key;
    touched = true;
  }

  // Salesforce Connected App credentials
  if (body?.sfClientId !== undefined || body?.sfClientSecret !== undefined) {
    const id = String(body?.sfClientId ?? "").trim();
    const secret = String(body?.sfClientSecret ?? "").trim();
    if (!id || !secret) {
      return NextResponse.json(
        { error: "Both Connected App Client ID and Client Secret are required." },
        { status: 400 },
      );
    }
    next.sfClientId = id;
    next.sfClientSecret = secret;
    touched = true;
  }

  if (!touched) {
    return NextResponse.json({ error: "No configuration fields provided." }, { status: 400 });
  }

  const res = NextResponse.json({
    success: true,
    hasAnthropicKey: Boolean(next.anthropicApiKey),
    hasConnectedApp: Boolean(next.sfClientId && next.sfClientSecret),
  });
  res.cookies.set(CONFIG_COOKIE, encodeConfig(next), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: CONFIG_MAX_AGE,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ success: true });
  res.cookies.set(CONFIG_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}
