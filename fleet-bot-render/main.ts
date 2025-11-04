// main.ts — Drive upload only, "Saving..." status, auto Sheets by sheetId, home keyboard with New report + Dashboard
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  createAccessToken,
  driveUpload,
  driveMakePublic,
  sheetsAppendRow,
  ensureSharedFolder,
} from "./google.ts";

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
const seen = new Set<number>();

// ---- keyboards
const kbDash = () => ({ inline_keyboard: [[{ text: "Open Dashboard", url: DASHBOARD_URL }]] });
const kbPaid = () => ({ keyboard: [[{text:"driver"},{text:"company"}]], resize_keyboard:true, one_time_keyboard:true, selective:true });
const kbUnit = () => ({ keyboard: [[{text:"truck"},{text:"trailer"}]], resize_keyboard:true, one_time_keyboard:true, selective:true });
const kbRemove = () => ({ remove_keyboard: true });
// Домашняя клавиатура: New report + Dashboard, ниже — выбор юнита
const kbHome = () => ({
  keyboard: [
    [{ text: "New report" }, { text: "Dashboard" }],
    [{ text: "truck" }, { text: "trailer" }],
  ],
  resize_keyboard: true,
  one_time_keyboard: false,
  selective: true,
});

// ---- helpers
function allowed(id:number){ return ALLOWED_CHAT_IDS.length===0 || ALLOWED_CHAT_IDS.includes(String(id)); }
function uname(u:any){ return u?.username? "@"+u.username : ((u?.first_name??"")+" "+(u?.last_name??"")).trim()||"unknown"; }
function dstr(tz:string){ return new Intl.DateTimeFormat("en-US",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()); }
async function send(id:number, text:string, markup?:any){
  const body:any={chat_id:id,text,parse_mode:"HTML"}; if(markup) body.reply_markup=markup;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
}
async function sendGetId(id:number, text:string, markup?:any){
  const body:any={chat_id:id,text,parse_mode:"HTML"}; if(markup) body.reply_markup=markup;
  const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const j=await r.json(); return j?.result?.message_id as number;
}
async function edit(id:number, mid:number, text:string, markup?:any){
  const body:any={chat_id:id,message_id:mid,text,parse_mode:"HTML"}; if(markup) body.reply_markup=markup;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
}
function asset(d:Draft){
  if(d.assetType==="truck" && d.truckNo) return `truck ${d.truckNo}`;
  if(d.assetType==="trailer" && d.trailerNo && d.truckNo) return `TRL ${d.trailerNo} (unit ${d.truckNo})`;
  if(d.assetType==="trailer" && d.trailerNo) return `TRL ${d.trailerNo}`;
  return d.asset ?? "";
}

// ---- flow
async function start(chat:number){
  state.set(chat,{step:"unitType",draft:{}});
  // Домашняя клавиатура сразу: New report + Dashboard + выбор юнита
  await send(chat,"New report. Choose <b>Unit</b>:", kbHome());
  // Дополнительно отдадим инлайн-кнопку к дашборду
  await send(chat," ", kbDash());
}
async function onText(chat:number, from:any, text:string){
  const t = text.trim();
  const startCmd = /^\/start|^new report$/i.test(t);

  // Быстрая обработка кнопки "Dashboard" из reply-клавиатуры
  if (/^dashboard$/i.test(t)) { await send(chat, "Dashboard:", kbDash()); return; }

  const st = state.get(chat) ?? {step:"unitType" as Step, draft:{}};
  if(startCmd || st.step==="done"){ await start(chat); return; }
  if(!allowed(chat)){ await send(chat,"Access denied for this chat."); return; }

  switch(st.step){
    case "unitType":{
      const v=t.toLowerCase();
      if(v!=="truck" && v!=="trailer"){ await send(chat,"Choose Unit: truck or trailer.", kbHome()); return; }
      st.draft.assetType=v as any; st.step="unitNumber"; state.set(chat,st);
      await send(chat, v==="truck"?"Enter <b>truck #</b>.":"Enter <b>trailer #</b>.", kbRemove()); break;
    }
    case "unitNumber":{
      const num=t; if(!num){ await send(chat,"Enter a valid number."); return; }
      if(st.draft.assetType==="truck"){
        st.draft.truckNo=num; st.draft.asset=asset(st.draft); st.step="repair"; state.set(chat,st);
        await send(chat,"Describe the <b>issue</b> (Repair).");
      }else{
        st.draft.trailerNo=num; st.step="linkTruck"; state.set(chat,st);
        await send(chat,"Truck # <b>connected with this trailer</b>?");
      } break;
    }
    case "linkTruck":{
      const num=t; if(!num){ await send(chat,"Enter truck #."); return; }
      st.draft.truckNo=num; st.draft.asset=asset(st.draft); st.step="repair"; state.set(chat,st);
      await send(chat,"Describe the <b>issue</b> (Repair)."); break;
    }
    case "repair":{
      st.draft.repair=t; st.step="paidby"; state.set(chat,st);
      await send(chat,"Paid by?", kbPaid()); break;
    }
    case "paidby":{
      const v=t.toLowerCase();
      if(v!=="driver" && v!=="company"){ await send(chat,"Choose: driver or company.", kbPaid()); return; }
      st.draft.paidBy=v as any; st.step="total"; state.set(chat,st);
      await send(chat,"Total amount (e.g. 59.20).", kbRemove()); break;
    }
    case "total":{
      const n=t.replace(",",".").replace(/[^\d.]/g,""); if(!n||Number.isNaN(Number(n))){ await send(chat,"Enter a valid number, e.g. 59.20"); return; }
      st.draft.total=String(Number(n)); st.step="notes"; state.set(chat,st);
      await send(chat,"Notes (optional). Send text or '-' to skip."); break;
    }
    case "notes":{
      st.draft.comments = t==="-" ? "" : t;
      st.step="invoice"; state.set(chat,st);
      await send(chat,"Send invoice (photo or PDF).", kbRemove());
      await send(chat," ", kbDash());
      break;
    }
    case "invoice": await send(chat,"Waiting for a photo or document. Send file."); break;
  }
}

// ---- file
async function onFile(chat:number, from:any, msg:any){
  const st=state.get(chat); if(!st || st.step!=="invoice") return;
  if(!DRIVE_FOLDER_ID){ await send(chat,"Config error: DRIVE_FOLDER_ID is empty."); return; }

  const mid = await sendGetId(chat,"Saving...");

  try{
    // select file
    let fileId:string|undefined, orig="invoice";
    if(msg.photo && Array.isArray(msg.photo) && msg.photo.length>0){
      const best=msg.photo[msg.photo.length-1]; fileId=best.file_id; orig="invoice.jpg";
    }else if(msg.document){ fileId=msg.document.file_id; orig=msg.document.file_name ?? "invoice.bin"; }
    if(!fileId){ await edit(chat,mid,"Unsupported file. Send a photo or a document (PDF/JPG/PNG)."); return; }

    // getFile → download
    const gf=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile`,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({file_id:fileId})
    });
    const gfj=await gf.json(); if(!gfj.ok){ await edit(chat,mid,"Failed to fetch file info from Telegram."); return; }
    const tgUrl=`https://api.telegram.org/file/bot${BOT_TOKEN}/${gfj.result.file_path}`;
    const fr=await fetch(tgUrl); if(!fr.ok){ await edit(chat,mid,`Download failed: ${fr.status}`); return; }
    const bytes=new Uint8Array(await fr.arrayBuffer());

    // Drive upload (Shared Drive required)
    const token=await createAccessToken();
    await ensureSharedFolder({ accessToken: token, folderId: DRIVE_FOLDER_ID });

    const mime=msg.document?.mime_type || "image/jpeg";
    const file=await driveUpload({
      accessToken:token, folderId:DRIVE_FOLDER_ID,
      name:`${chat}-${Date.now()}-${orig}`, mimeType:mime, bytes
    });

    if(PUBLIC_LINK){ try{ await driveMakePublic({accessToken:token,fileId:file.id}); }catch(e){ console.warn("perm:",e); } }
    const link=`https://drive.google.com/file/d/${file.id}/view`;

    // Append to Sheets (by sheetId)
    const d=st.draft;
    await sheetsAppendRow({
      accessToken: token,
      spreadsheetId: SPREADSHEET_ID,
      sheetName: SHEET_NAME,
      values: [ dstr(TIMEZONE), asset(d), d.repair??"", d.total??"", d.paidBy??"", uname(from), link, d.comments??"" ],
    });

    state.set(chat,{step:"done",draft:{}});
    await edit(chat, mid, "Saved.");
    // Возвращаем домашнюю клавиатуру с New report + Dashboard
    await send(chat, "Choose next action:", kbHome());
    // И дублируем инлайн-кнопку с URL
    await send(chat, " ", kbDash());
  }catch(e){
    console.error("upload error:", e);
    await edit(chat, mid, `Error while saving invoice: ${(e as Error).message}`);
  }
}

// ---- dispatcher + http
async function handleUpdate(u:any){
  if(typeof u.update_id==="number"){ if(seen.has(u.update_id)) return; seen.add(u.update_id); }
  const m=u.message ?? u.edited_message; if(!m) return;
  const chat=m.chat?.id; if(typeof chat!=="number") return;
  const from=m.from;

  const isGroup=["group","supergroup"].includes(m.chat?.type);
  if(isGroup){
    const t=m.text ?? ""; const mentioned = t.includes("@") || (m.entities??[]).some((e:any)=>e.type==="mention");
    const replyToBot = m.reply_to_message?.from?.is_bot;
    if(!mentioned && !replyToBot) return;
  }

  if(m.text) await onText(chat, from, m.text);
  else if(m.photo || m.document) await onFile(chat, from, m);
}

async function httpHandler(req:Request):Promise<Response>{
  try{
    const url=new URL(req.url);
    if(url.pathname==="/webhook" && req.method==="POST"){
      if(WEBHOOK_SECRET){
        const tok=req.headers.get("x-telegram-bot-api-secret-token") ?? "";
        if(tok!==WEBHOOK_SECRET) return new Response("forbidden",{status:403});
      }
      const upd=await req.json().catch(()=>null); if(upd) try{ await handleUpdate(upd); }catch(e){ console.error("upd:",e); }
      return new Response("ok");
    }
    if(url.pathname==="/health") return new Response("ok");
    return new Response("not found",{status:404});
  }catch(e){ console.error("http:",e); return new Response("ok"); }
}

console.log(`Listening on :${PORT}`);
serve(httpHandler,{hostname:"0.0.0.0",port:PORT});
