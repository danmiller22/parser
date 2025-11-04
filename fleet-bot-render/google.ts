// google.ts — JWT auth, Drive (Shared Drive), Sheets append via batchUpdate by sheetId
const GOOGLE_CLIENT_EMAIL = Deno.env.get("GOOGLE_CLIENT_EMAIL") ?? "";
const GOOGLE_PRIVATE_KEY = (Deno.env.get("GOOGLE_PRIVATE_KEY") ?? "").replace(/\\n/g, "\n");

let cachedToken: { token: string; exp: number } | null = null;

// utils
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
  const key = await crypto.subtle.importKey(
    "pkcs8",
    str2ab(GOOGLE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

// OAuth2
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

// Drive
async function driveGetFile(args: { accessToken: string; fileId: string }) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${args.fileId}?fields=id,name,driveId,mimeType,parents&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } }
  );
  if (!res.ok) throw new Error(`drive get file error: ${res.status} ${await res.text()}`);
  return await res.json() as { id:string; name:string; driveId?:string; mimeType:string; parents?:string[] };
}
export async function ensureSharedFolder(args: { accessToken: string; folderId: string }) {
  const meta = await driveGetFile({ accessToken: args.accessToken, fileId: args.folderId });
  if (!meta.driveId) throw new Error(`Folder ${args.folderId} is not in a Shared Drive.`);
  if (meta.mimeType !== "application/vnd.google-apps.folder") throw new Error(`File ${args.folderId} is not a folder.`);
}
export async function driveUpload(args: { accessToken: string; folderId: string; name: string; mimeType: string; bytes: Uint8Array; }) {
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

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
    { method: "POST", headers: { Authorization: `Bearer ${args.accessToken}` }, body }
  );
  const j = await res.json();
  if (!res.ok) throw new Error(`drive upload error: ${res.status} ${JSON.stringify(j)}`);
  return j; // { id, name, ... }
}
export async function driveMakePublic(args: { accessToken: string; fileId: string; }) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${args.fileId}/permissions?supportsAllDrives=true`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${args.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    }
  );
  if (!res.ok) throw new Error(`drive perm error: ${res.status} ${await res.text()}`);
}

// Sheets — append by sheetId (без A1)
function norm(s: string) {
  return s
    .replace(/\u00A0/g, " ")
    .replace(/\u2009|\u202F|\u2007/g, " ")
    .replace(/[\u2012\u2013\u2014\u2015]/g, "—")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
async function resolveSheetId(args: { accessToken: string; spreadsheetId: string; sheetName: string }): Promise<number> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } }
  );
  const j = await res.json();
  if (!res.ok) throw new Error(`sheets metadata error: ${res.status} ${JSON.stringify(j)}`);
  const wanted = norm(args.sheetName);
  const sheets: Array<{properties:{sheetId:number,title:string}}> = j.sheets ?? [];
  for (const s of sheets) if (norm(s.properties.title) === wanted) return s.properties.sheetId;
  const titles = sheets.map(s=>s.properties.title).join(", ");
  throw new Error(`Sheet "${args.sheetName}" not found. Available: ${titles}`);
}
function toCell(v: any) { return { userEnteredValue: { stringValue: String(v ?? "") } }; }

export async function sheetsAppendRow(args: {
  accessToken: string; spreadsheetId: string; sheetName: string; values: any[]; // single row
}) {
  const sheetId = await resolveSheetId({ accessToken: args.accessToken, spreadsheetId: args.spreadsheetId, sheetName: args.sheetName });

  const body = {
    requests: [
      {
        appendCells: {
          sheetId,
          rows: [{ values: args.values.map(toCell) }],
          fields: "userEnteredValue",
        }
      }
    ]
  };

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${args.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`sheets append error: ${res.status} ${await res.text()}`);
}
