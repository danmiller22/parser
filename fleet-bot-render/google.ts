// Minimal JWT auth + Drive upload + Sheets append (Shared Drive ready)
const GOOGLE_CLIENT_EMAIL = Deno.env.get("GOOGLE_CLIENT_EMAIL") ?? "";
const GOOGLE_PRIVATE_KEY = (Deno.env.get("GOOGLE_PRIVATE_KEY") ?? "").replace(/\\n/g, "\n");

let cachedToken: { token: string; exp: number } | null = null;

function b64url(input: Uint8Array): string {
  return btoa(String.fromCharCode(...input)).replace(/=+$/,"").replace(/\+/g,"-").replace(/\//g,"_");
}
function str2ab(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g,"").replace(/\s+/g,"");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
async function jwtSignRS256(header: object, claim: object): Promise<string> {
  const enc = (obj: any) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const data = `${enc(header)}.${enc(claim)}`;
  const key = await crypto.subtle.importKey("pkcs8", str2ab(GOOGLE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

export async function createAccessToken(): Promise<string> {
  const now = Math.floor(Date.now()/1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;
  const scope = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/spreadsheets",
  ].join(" ");
  const claim = { iss: GOOGLE_CLIENT_EMAIL, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now+3600 };
  const jwt = await jwtSignRS256({ alg: "RS256", typ: "JWT" }, claim);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt })
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`token error: ${res.status} ${JSON.stringify(j)}`);
  cachedToken = { token: j.access_token, exp: now + 3600 };
  return j.access_token as string;
}

export async function driveUpload(args: { accessToken: string; folderId: string; name: string; mimeType: string; bytes: Uint8Array; }) {
  // parents=[shared-drive-folder-id], supportsAllDrives=true
  const metadata = { name: args.name, parents: [args.folderId] };
  const boundary = "deno-"+crypto.randomUUID();
  const body = new Blob([
    `--${boundary}\r\n`,
    `Content-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata), `\r\n`,
    `--${boundary}\r\n`,
    `Content-Type: ${args.mimeType}\r\n\r\n`,
    new Blob([args.bytes]), `\r\n`,
    `--${boundary}--`
  ], { type: "multipart/related; boundary="+boundary });

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${args.accessToken}` },
    body,
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`drive upload error: ${res.status} ${JSON.stringify(j)}`);
  return j; // -> { id, name, ... }
}

export async function driveMakePublic(args: { accessToken: string; fileId: string; }) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${args.fileId}/permissions?supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${args.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`drive perm error: ${res.status} ${t}`); }
}

export async function sheetsAppend(args: { accessToken: string; spreadsheetId: string; sheetName: string; values: any[][] }) {
  const range = encodeURIComponent(`${args.sheetName}!A:H`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`, {
    method: "POST",
    headers: { Authorization: `Bearer ${args.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ values: args.values }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`sheets append error: ${res.status} ${t}`); }
}
