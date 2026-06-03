import { NextRequest, NextResponse } from "next/server";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { username, password, securityToken = "", environment } = body as {
    username: string;
    password: string;
    securityToken?: string;
    environment: string;
  };

  if (!username || !password) {
    return NextResponse.json(
      { error: "Username and password are required" },
      { status: 400 }
    );
  }

  const baseUrl =
    environment === "production"
      ? "https://login.salesforce.com"
      : "https://test.salesforce.com";

  const soapXml = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Body>
    <n1:login xmlns:n1="urn:partner.soap.sforce.com">
      <n1:username>${escapeXml(username)}</n1:username>
      <n1:password>${escapeXml(password + securityToken)}</n1:password>
    </n1:login>
  </env:Body>
</env:Envelope>`;

  let sfResponse: Response;
  try {
    sfResponse = await fetch(`${baseUrl}/services/Soap/u/59.0`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: "login",
      },
      body: soapXml,
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to reach Salesforce. Check your network connection." },
      { status: 503 }
    );
  }

  const text = await sfResponse.text();

  // SOAP faults come back as HTTP 500 with faultstring in body
  const faultMatch = text.match(/<faultstring>([\s\S]*?)<\/faultstring>/);
  if (faultMatch) {
    return NextResponse.json({ error: faultMatch[1].trim() }, { status: 401 });
  }

  const sessionIdMatch = text.match(/<sessionId>([\s\S]*?)<\/sessionId>/);
  const serverUrlMatch = text.match(/<serverUrl>([\s\S]*?)<\/serverUrl>/);
  const userIdMatch = text.match(/<userId>([\s\S]*?)<\/userId>/);

  if (!sessionIdMatch || !serverUrlMatch) {
    return NextResponse.json(
      { error: "Unexpected response from Salesforce" },
      { status: 502 }
    );
  }

  return NextResponse.json({
    sessionId: sessionIdMatch[1].trim(),
    serverUrl: serverUrlMatch[1].trim(),
    userId: userIdMatch?.[1].trim(),
  });
}
