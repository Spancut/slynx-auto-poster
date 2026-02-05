import { google } from "googleapis";
import fetch from "node-fetch";

// ---------- helpers ----------
function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var: ${name}`);
  return String(v).trim();
}

function quoteSheetName(name) {
  // Google Sheets supports quoting tab names with single quotes.
  // If tab name itself contains a single quote, escape by doubling it.
  const safe = name.replace(/'/g, "''");
  return `'${safe}'`;
}

function fatal(msg, err) {
  console.error(`Fatal error: ${msg}`);
  if (err?.message) console.error(err.message);
  process.exit(1);
}

// ---------- Google Sheets ----------
async function getSheetsClient() {
  const clientId = mustEnv("GOOGLE_CLIENT_ID");
  const clientSecret = mustEnv("GOOGLE_CLIENT_SECRET");
  const refreshToken = mustEnv("GOOGLE_REFRESH_TOKEN");

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return google.sheets({ version: "v4", auth: oauth2Client });
}

async function assertTabExists(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(title))",
  });

  const titles = (meta.data.sheets || []).map(s => s.properties?.title).filter(Boolean);

  const match = titles.find(t => t === tabName);
  if (!match) {
    console.error("Your GOOGLE_SHEET_TAB does not match any tab in the sheet.");
    console.error("Provided:", JSON.stringify(tabName));
    console.error("Available tabs:");
    titles.forEach(t => console.error(" -", JSON.stringify(t)));
    throw new Error("Tab not found");
  }
}

async function fetchRows() {
  const spreadsheetId = mustEnv("GOOGLE_SHEET_ID");
  const tabNameRaw = mustEnv("GOOGLE_SHEET_TAB");
  const tabName = tabNameRaw.trim();

  const sheets = await getSheetsClient();

  // Verify tab exists (stops range/404 nonsense early)
  await assertTabExists(sheets, spreadsheetId, tabName);

  // Always quote tab name for safety
  const range = `${quoteSheetName(tabName)}!A:Z`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const values = res.data.values || [];
  if (values.length < 2) return []; // header only or empty

  const headers = values[0].map(h => String(h).trim());
  const rows = values.slice(1).map((row, idx) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i] ?? ""));
    obj.__rowIndex = idx + 2; // 1-based, + header row
    return obj;
  });

  return rows;
}

// ---------- X posting (minimal placeholder, keep your existing logic) ----------
async function postToX({ text }) {
  // Replace this with your actual X posting logic already in your repo.
  // This is just a placeholder so the file is syntactically complete.
 const text = String(row["Post Text"] || "").trim();
 if (!text) throw new Error(`Row ${rowNumber} has empty Post Text`);
}

// ---------- main ----------
async function main() {
  try {
    // Quick visibility (won't leak secrets)
    console.log("Sheet ID length:", (process.env.GOOGLE_SHEET_ID || "").length);
    console.log("Tab:", JSON.stringify((process.env.GOOGLE_SHEET_TAB || "").trim()));

    const rows = await fetchRows();

    // Find first Pending row with Post Text
    const pending = rows.find(r =>
      String(r["Status"] || "").toLowerCase() === "pending" &&
      String(r["Post Text"] || "").trim()
    );

    if (!pending) {
      console.log("No Pending posts found. Exiting cleanly.");
      return;
    }

    const text = String(pending["Post Text"]).trim();
    console.log("Posting row:", pending.__rowIndex);

    const result = await postToX({ text });

    if (!result.ok) {
      throw new Error(`X post failed: ${result.reason || "unknown"}`);
    }

    console.log("Posted to X successfully:", result.id);
    // NOTE: If you already have update-row logic in your repo, keep it there.
    // This file focuses on fixing the Sheets range errors first.
  } catch (e) {
    fatal(e.message || "Unknown error", e);
  }
}

main();
