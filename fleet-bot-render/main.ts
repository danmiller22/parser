// main.ts — Render-ready bot: unit-type flow + safe Drive/Sheets + clean keyboards
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createAccessToken, driveUpload, driveMakePublic, sheetsAppend } from "./google.ts";

// ENV
const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
const SPREADSHEET_ID = Deno.env.get("SPREADSHEET_ID") ?? "";
const SHEET_NAME = Deno.env.get("SHEET_NAME") ?? "Sheet1";
const DRIVE_FOLDER_ID = Deno.env.get("DRIVE_FOLDER_ID") ?? "";
const ALLOWED_CHAT_IDS = (Deno.env.get("ALLOWED_CHAT_IDS") ?? "").split(",").map(s=>s.trim()).filter(Boolean);
const TIMEZONE = Deno.env.get("TIMEZONE") ?? "America/Chicago";
const DASHBOARD_URL = Deno.env.get("DASHBOARD_URL") ?? "https://danmiller22.github.io/us-team-fleet-dashboard/";
const PUBLIC_LINK = (Deno.env.get("PUBLIC_LINK") ?? "true").toLowerCase() === "true";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
const PORT = Number(Deno.env.get("PORT") ?? "8080");

// ---- state
type Step = "unitType"|"unitNumber"|"linkTruck"|"repair"|"paidby"|"total"|"notes"|"invoice"|"done";
type Draft = {
  asset?: string; assetType?: "truck"|"trailer";
  truckNo?: string; trailerNo?: string;
  repair?: string; paidBy?: "driver"|"company"; total?: string; comments?: string;
};
const state = new Map<number, { step: Step; draft: Draft }>();
const seenUpdates = new Set<number>();

// ---- keyboards
const kbDashboard = () => ({ inline_keyboard: [[{ text: "Open Dashboard", url: DASHBOARD_URL }]] });
const kbPaidBy    = () => ({ keyboard: [[{text:"driver"},{text:"company"}]], resize_keyboard: true, one_time_keyboard: true, selective: true });
const kbUnitType  = () => ({ keyboard: [[{text:"truck"},{text:"trailer"}]], resize_keyboard: true, one_time_keyboard: true, selective: true });
const kbRemove    = () => ({ remove_keyboard: true });

// ---- helpers
function allowed(chatId: number) { return ALLOWED_CHAT_IDS.length === 0 || ALLOWED_CHAT_IDS.includes(String(chatId)); }
function usernameOf(u: any) { return u?.username ? "@"+u.username : ((u?.first_name ?? "") + " " + (u?.last_name ?? "")).trim() || "unknown"; }
function fmtDate(tz: string) { return new Intl.DateTimeFormat("en-US", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date()); }
async function send(chatId: number, text: string, keyboard?: any) {
  const body: any = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = keyboard;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
}
function buildAsset(d: Draft): string {
  if (d.assetType === "truck" && d.truckNo) return `truck ${d.truckNo}`;
  if (d.assetType === "trailer" && d.trailerNo && d.truckNo) return `TRL ${d.trailerNo} (unit ${d.truckNo})`;
  if (d.assetType === "trailer" && d.trailerNo) return `TRL ${d.trailerNo}`;
  return d.asset ?? "";
}

// ---- flow
async function startFlow(chatId: number) {
  state.set(chatId, { step: "unitType", draft: {} });
  await send(chatId, "New report.\nChoose <b>Unit</b>:", kbUnitType());
  await send(chatId, " ", kbDashboard());
}
async function handleText(chatId: number, from: any, text: string) {
  const isStart = /^\/start|^new report$/i.test(text.trim());
  const st = state.get(chatId) ?? { step: "unitType" as Step, draft: {} };
  if (isStart || st.step === "done") { await startFlow(chatId); return; }
  if (!allowed(chatId)) { await send(chatId, "Access denied for this chat."); return; }

  switch (st.step) {
    case "unitType": {
      const v = text.trim().toLowerCase();
      if (v !== "truck" && v !== "trailer") { await send(chatId, "Choose Unit: truck or trailer.", kbUnitType()); return; }
      st.draft.assetType = v as "truck"|"trailer";
      st.step = "unitNumber"; state.set(chatId, st);
      await send(chatId, v === "truck" ? "Enter <b>truck #</b>." : "Enter <b>trailer #</b>.", kbRemove());
      break;
    }
    case "unitNumber": {
      const num = text.trim(); if (!num) { await send(chatId, "Enter a valid number."); return; }
      if (st.draft.assetType === "truck") {
        st.draft.truckNo = num; st.draft.asset = buildAsset(st.draft);
        st.step = "repair"; state.set(chatId, st);
        await send(chatId, "Describe the <b>issue</b> (Repair).");
      } else {
        st.draft.trailerNo = num;
        st.step = "linkTruck"; state.set(chatId, st);
        await send(chatId, "Truck # <b>connected with this trailer</b>?");
      }
      break;
    }
    case "linkTruck": {
      const num = text.trim(); if (!num) { await send(chatId, "Enter truck #."); return; }
      st.draft.truckNo = num; st.draft.asset = buildAsset(st.draft);
      st.step = "repair"; state.set(chatId, st);
      await send(chatId, "Describe the <b>issue</b> (Repair).");
      break;
    }
    case "repair":
      st.draft.repair = text.trim();
      st.step = "paidby"; state.set(chatId, st);
      await send(chatId, "Paid by?", kbPaidBy());
      break;
    case "paidby": {
      const v = text.trim().toLowerCase();
      if (v !== "driver" && v !== "company") { await send(chatId, "Choose: driver or company.", kbPaidBy()); return; }
      st.draft.paidBy = v as any;
      st.step = "total"; state.set(chatId, st);
      await send(chatId, "Total amount (e.g. 59.20).", kbRemove()); // remove keyboard
      break;
    }
    case "total": {
      const normalized = text.replace(",", ".").replace(/[^\d.]/g, "");
      if (!normalized || Number.isNaN(Number(normalized))) { await send(chatId, "Enter a valid number, e.g. 59.20"); return; }
      st.draft.total = String(Number(normalized));
      st.step = "notes"; state.set(chatId, st);
      await send(chatId, "Notes (optional). Send text or '-' to skip.");
      break;
    }
    case "notes":
      st.draft.comments = text.trim() === "-" ? "" : text.trim();
      st.step = "invoice"; state.set(chatId, st);
      await send(chatId, "Send invoice (photo or PDF).", kbRemove());
      await send(chatId, " ", kbDashboard());
      break;
    case "invoice":
      await send(chatId, "Waiting for a photo or document. Send file.");
      break;
  }
}

// ---- robust file handling
async function handleFile(chatId: number, from: any, msg: any) {
  const st = state.get(chatId);
  if (!st || st.step !== "invoice") return;

  if (!DRIVE_FOLDER_ID) { await send(chatId, "Config error: DRIVE_FOLDER_ID is empty."); return; }

  try {
    let fileId: string|undefined;
    let originalName = "invoice";
    if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
      const best = msg.photo[msg.photo.length - 1];
      fileId = best.file_id; originalName = "invoice.jpg";
    } else if (msg.document) {
      fileId = msg.document.file_id; originalName = msg.document.file_name ?? "invoice.bin";
    }
    if (!fileId) { await send(chatId, "Unsupported file. Send a photo or a document (PDF/JPG/PNG)."); return; }

    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file_id: fileId }),
    });
    const jr = await r.json(); console.log("getFile resp:", jr);
    if (!jr.ok) { await send(chatId, "Failed to fetch file info from Telegram."); return; }

    const tgFileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${jr.result.file_path}`;
    const fileRes = await fetch(tgFileUrl);
    if (!fileRes.ok) { console.error("download failed", fileRes.status, await fileRes.text()); throw new Error("download failed"); }
    const bytes = new Uint8Array(await fileRes.arrayBuffer());

    const token = await createAccessToken();
    const mime = msg.document?.mime_type || "image/jpeg";
    const driveFile = await driveUpload({
      accessToken: token, folderId: DRIVE_FOLDER_ID,
      name: `${chatId}-${Date.now()}-${originalName}`, mimeType: mime, bytes,
    });
    console.log("drive upload:", driveFile);

    if (PUBLIC_LINK) { try { await driveMakePublic({ accessToken: token, fileId: driveFile.id }); } catch (e) { console.warn("make public failed:", e); } }
    const link = `https://drive.google.com/file/d/${driveFile.id}/view`;

    const d = st.draft;
    const values = [[
      fmtDate(TIMEZONE),
      buildAsset(d),
      d.repair ?? "",
      d.total ?? "",
      d.paidBy ?? "",
      usernameOf(from),
      link,
      d.comments ?? ""
    ]];
    await sheetsAppend({ accessToken: token, spreadsheetId: SPREADSHEET_ID, sheetName: SHEET_NAME, values });

    state.set(chatId, { step: "done", draft: {} });
    await send(chatId, "Saved.\nOpen Dashboard or send 'New report' to start again.", kbDashboard());
  } catch (e) {
    console.error("handleFile error:", e);
    await send(chatId, `Error while saving invoice: ${(e as Error).message}`);
  }
}

// ---- dispatcher
async function handleUpdate(update: any) {
  if (typeof update.update_id === "number") { if (seenUpdates.has(update.update_id)) return; seenUpdates.add(update.update_id); }
  const msg = update.message ?? update.edited_message; if (!msg) return;
  const chatId = msg.chat?.id; if (typeof chatId !== "number") return;
  const from = msg.from;

  const isGroup = ["group","supergroup"].includes(msg.chat?.type);
  if (isGroup) {
    const text = msg.text ?? "";
    const hasMention = text.includes("@") || (msg.entities ?? []).some((e:any)=>e.type==="mention");
    const replyToBot = msg.reply_to_message?.from?.is_bot;
    if (!hasMention && !replyToBot) return;
  }
  if (msg.text) await handleText(chatId, from, msg.text);
  else if (msg.photo || msg.document) await handleFile(chatId, from, msg);
}

// ---- http
async function httpHandler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    if (url.pathname === "/webhook" && req.method === "POST") {
      if (WEBHOOK_SECRET) {
        const hdr = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
        if (hdr !== WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      }
      const update = await req.json().catch(()=>null);
      if (update) { try { await handleUpdate(update); } catch (e) { console.error("handleUpdate error:", e); } }
      return new Response("ok");
    }
    if (url.pathname === "/health") return new Response("ok");
    return new Response("not found", { status: 404 });
  } catch (e) {
    console.error("http fatal:", e);
    return new Response("ok");
  }
}

console.log(`Listening on :${PORT}`);
serve(httpHandler, { port: PORT, hostname: "0.0.0.0" });
