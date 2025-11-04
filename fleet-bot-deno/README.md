# Fleet Repair Bot (Deno + GitHub + Deno Deploy)

Minimal Telegram questionnaire bot. Writes rows to Google Sheets. Uploads invoice photo/PDF to Google Drive. Adds a Dashboard button.

## Columns (fixed)
```
Date | Asset | Repair | Total | PaidBy | ReportedBy | InvoiceLink | Comments
```

## What it does
- Step-by-step chat flow in English.
- Reply keyboard for **Paid By** (`driver`, `company`).
- Inline button **Dashboard** opens your URL.
- Invoice upload: accepts **photo** or **document (PDF/JPG/PNG)**.
- Saves file to the Drive folder and writes a public or restricted link (configurable).
- Appends one row per report to your Google Sheet.
- Idempotency within a process using Telegram `update_id` cache.

## Deploy fast
1. **Fork/Import** this repo to GitHub.
2. Open **Deno Deploy** → **New Project** → Import from GitHub.
3. Set Environment Variables:
```
BOT_TOKEN=REPLACE_ME
GOOGLE_CLIENT_EMAIL=client-email@...gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
SPREADSHEET_ID=1yJIieOP9u4LAj1tizjOKtzGoHcTQwTVslj5fQ3nGMKA
SHEET_NAME=Sheet1
DRIVE_FOLDER_ID=14sM35W7dCC96aX3W25XEF28eKyGdz_4E
ALLOWED_CHAT_IDS=12345,-100222333444
TIMEZONE=America/Chicago
DASHBOARD_URL=https://danmiller22.github.io/us-team-fleet-dashboard/
PUBLIC_LINK=true
WEBHOOK_SECRET=choose-a-random-string
```
4. Deploy. Copy the public URL. Set Telegram webhook:
```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<YOUR_DENO_URL>/webhook&secret_token=<WEBHOOK_SECRET>
```
5. Test in DM and in allowed groups.

## Notes
- If you need different sheet tab name, change `SHEET_NAME` env.
- Numbers accept comma or dot. `59,20` → `59.20`.
- Public sharing: set `PUBLIC_LINK=true` to add `anyoneWithLink` permission after upload.

## Local dev (optional)
Deno 1.39+:
```
deno task dev
```
Then use a tunnel to expose `/webhook` and set a temporary webhook URL.

