// main.ts — Deno HTTP server + Telegram bot logic
import { createAccessToken, driveUpload, driveMakePublic, sheetsAppend } from "./google.ts";

// --- ENV ---
const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
const SPREADSHEET_ID = Deno.env.get("SPREADSHEET_ID") ?? "";
const SHEET_NAME = Deno.env.get("SHEET_NAME") ?? "Sheet1";
const DRIVE_FOLDER_ID = Deno.env.get("DRIVE_FOLDER_ID") ?? "";
const ALLOWED_CHAT_IDS = (Deno.env.get("ALLOWED_CHAT_IDS") ?? "").split(",").map(s=>s.trim()).filter(Boolean);
const TIMEZONE = Deno.env.get("TIMEZONE") ?? "America/Chicago";
const DASHBOARD_URL = Deno.env.get("DASHBOARD_URL") ?? "https://danmiller22.github.io/us-team-fleet-dashboard/";
const PUBLIC_LINK = (Deno.env.get("PUBLIC_LINK") ?? "true").toLowerCase() === "true";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";

// --- Simple in-memory state ---
type Step = "asset"|"repair"|"paidby"|"total"|"notes"|"invoice"|"done";
type Draft = { asset?: string; repair?: string; paidBy?: "driver"|"company"; total?: string; comments?: string; };
const state = new Map<number, { step: Step; draft: Draft }>();
const seenUpdates = new Set<number>();

function isAllowed(chatId: number): boolean {
  if (ALLOWED_CHAT_IDS.length === 0) return true;
  return ALLOWED_CHAT_IDS.includes(String(chatId));
}
function usernameOf(u: any): string {
  if (!u) return "unknown";
  if (u.username) return "@"+u.username;
  const first = u.first_name ?? "";
  const last = u.last_name ?? "";
  return (first+" "+last).trim() || "unknown";
}
function fmtDate(tz: string): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  return fmt.format(now);
}
async function send(chatId: number, text: string, keyboard?: any) {
  const body: any = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = keyboard;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function dashboardInline() {
  return { inline_keyboard: [[{ text: "Open Dashboard", url: DASHBOARD_URL }]] };
}
function paidByKeyboard() {
  return { keyboard: [[{text:"driver"},{text:"company"}]], resize_keyboard: true, one_time_keyboard: true, selective: true };
}

async function handleText(chatId: number, from: any, text: string) {
  const isStart = /^\/start|^new report$/i.test(text.trim());
  const st = state.get(chatId) ?? { step: "asset" as Step, draft: {} };
  if (isStart || st.step === "done") {
    state.set(chatId, { step: "asset", draft: {} });
    await send(chatId, "New report.\nSend <b>Asset</b> (e.g. <code>TRL 8034 (unit 5975)</code> or <code>truck 5626</code>).", dashboardInline());
    return;
  }
  if (!isAllowed(chatId)) {
    await send(chatId, "Access denied for this chat.");
    return;
  }
  switch (st.step) {
    case "asset":
      st.draft.asset = text.trim();
      st.step = "repair";
      state.set(chatId, st);
      await send(chatId, "Describe the <b>issue</b> (Repair).");
      break;
    case "repair":
      st.draft.repair = text.trim();
      st.step = "paidby";
      state.set(chatId, st);
      await send(chatId, "Paid by?", paidByKeyboard());
      break;
    case "paidby": {
      const v = text.trim().toLowerCase();
      if (v !== "driver" && v !== "company") {
        await send(chatId, "Choose: driver or company.", paidByKeyboard());
        return;
      }
      st.draft.paidBy = v as any;
      st.step = "total";
      state.set(chatId, st);
      await send(chatId, "Total amount (e.g. 59.20).");
      break;
    }
    case "total": {
      const normalized = text.replace(",", ".").replace(/[^\d.]/g, "");
      if (!normalized || Number.isNaN(Number(normalized))) {
        await send(chatId, "Enter a valid number, e.g. 59.20");
        return;
      }
      st.draft.total = String(Number(normalized));
      st.step = "notes";
      state.set(chatId, st);
      await send(chatId, "Notes (optional). Send text or '-' to skip.");
      break;
    }
    case "notes":
      st.draft.comments = text.trim() === "-" ? "" : text.trim();
      st.step = "invoice";
      state.set(chatId, st);
      await send(chatId, "Send invoice (photo or PDF).", dashboardInline());
      break;
    case "invoice":
      await send(chatId, "Waiting for a photo or document. Send file.");
      break;
  }
}

async function handleFile(chatId: number, from: any, msg: any) {
  const st = state.get(chatId);
  if (!st || st.step !== "invoice") {
    // ignore files outside flow
    return;
  }
  // Resolve file_id: photo[] or document
  let fileId: string|undefined;
  let originalName = "invoice";
  if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1];
    fileId = best.file_id;
    originalName = "invoice.jpg";
  } else if (msg.document) {
    fileId = msg.document.file_id;
    originalName = msg.document.file_name ?? "invoice.bin";
  }
  if (!fileId) {
    await send(chatId, "Unsupported file. Send a photo or a document (PDF/JPG/PNG).");
    return;
  }
  // Get file path from Telegram
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const jr = await r.json();
  if (!jr.ok) {
    await send(chatId, "Failed to fetch file info from Telegram.");
    return;
  }
  const filePath = jr.result.file_path as string;
  const tgFileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

  // Download bytes
  const fileRes = await fetch(tgFileUrl);
  const ab = await fileRes.arrayBuffer();
  const bytes = new Uint8Array(ab);

  // Upload to Drive
  const token = await createAccessToken();
  const driveFile = await driveUpload({
    accessToken: token,
    folderId: DRIVE_FOLDER_ID,
    name: `${chatId}-${Date.now()}-${originalName}`,
    mimeType: msg.document?.mime_type || "image/jpeg",
    bytes,
  });
  let link = `https://drive.google.com/file/d/${driveFile.id}/view`;
  if (PUBLIC_LINK) {
    try { await driveMakePublic({ accessToken: token, fileId: driveFile.id }); } catch {}
  }

  // Append row
  const draft = st.draft;
  const date = fmtDate(TIMEZONE);
  const reportedBy = usernameOf(from);
  const values = [[
    date, draft.asset ?? "", draft.repair ?? "", draft.total ?? "",
    draft.paidBy ?? "", reportedBy, link, draft.comments ?? ""
  ]];
  await sheetsAppend({
    accessToken: token,
    spreadsheetId: SPREADSHEET_ID,
    sheetName: SHEET_NAME,
    values,
  });

  state.set(chatId, { step: "done", draft: {} });
  await send(chatId, "Saved.\nOpen Dashboard or send 'New report' to start again.", dashboardInline());
}

async function handleUpdate(update: any) {
  if (typeof update.update_id === "number") {
    if (seenUpdates.has(update.update_id)) return;
    seenUpdates.add(update.update_id);
  }
  const msg = update.message ?? update.edited_message;
  if (!msg) return;
  const chatId = msg.chat?.id;
  if (typeof chatId !== "number") return;
  const from = msg.from;

  // Group behavior: respond only on @mention or replies to bot
  const isGroup = ["group","supergroup"].includes(msg.chat?.type);
  if (isGroup) {
    const text = msg.text ?? "";
    const hasMention = text.includes("@") || (msg.entities ?? []).some((e:any)=>e.type==="mention");
    const replyToBot = msg.reply_to_message?.from?.is_bot;
    if (!hasMention && !replyToBot) return;
  }

  if (msg.text) {
    await handleText(chatId, from, msg.text);
  } else if (msg.photo || msg.document) {
    await handleFile(chatId, from, msg);
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === "/webhook" && req.method === "POST") {
    if (WEBHOOK_SECRET) {
      const hdr = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (hdr !== WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
    }
    const update = await req.json().catch(()=>null);
    if (update) await handleUpdate(update);
    return new Response("ok");
  }
  if (url.pathname === "/health") {
    return new Response("ok");
  }
  return new Response("not found", { status: 404 });
});
