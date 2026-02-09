import { chromium } from "playwright";
import fetch from "node-fetch";
import fs from "fs";

/* ================= ENV ================= */
const EMAIL = process.env.PORTAL_EMAIL;
const PASSWORD = process.env.PORTAL_PASSWORD;
const VIASOCKET_WEBHOOK = process.env.VIASOCKET_WEBHOOK;

if (!EMAIL || !PASSWORD || !VIASOCKET_WEBHOOK) {
  throw new Error("Missing environment variables");
}

/* ================= CONFIG ================= */
const PROJECT_ID = 21;

/* ================= CURSOR ================= */
let LAST_CREATED_AT = "1970-01-01 00:00:00";

if (fs.existsSync("cursor.json")) {
  const cursor = JSON.parse(fs.readFileSync("cursor.json", "utf8"));
  LAST_CREATED_AT = cursor.last_created_at || LAST_CREATED_AT;
}

const IS_FIRST_RUN = LAST_CREATED_AT === "1970-01-01 00:00:00";

console.log("PROJECT_ID:", PROJECT_ID);
console.log("MODE:", IS_FIRST_RUN ? "BACKFILL" : "INCREMENTAL");
console.log("LAST_CREATED_AT:", LAST_CREATED_AT);

/* ================= HELPERS ================= */

const formatDate = (d) => {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
};

function getLast6MonthRanges() {
  const ranges = [];
  const now = new Date();

  for (let i = 0; i < 6; i++) {
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    const start = new Date(end.getFullYear(), end.getMonth(), 1);
    ranges.push(`${formatDate(start)} - ${formatDate(end)}`);
  }

  return ranges;
}

const normalize = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return "";
  return String(v).trim();
};

async function waitForAuthCookie(context, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cookies = await context.cookies();
    if (cookies.some(c => c.name === "sv_forms_session")) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("Auth cookie not detected");
}

/* ================= MAIN ================= */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let recordsToSend = [];

  try {
    /* ===== LOGIN ===== */
    await page.goto("https://svform.urbanriseprojects.in/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForSelector('input[type="password"]');
    await page.fill('input[type="email"], input[name="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.waitForTimeout(2000);

    await page.click("button");

    await waitForAuthCookie(context);
    console.log("Login successful");

    const cookies = await context.cookies();
    const xsrf = cookies.find(c => c.name === "XSRF-TOKEN");
    const session = cookies.find(c => c.name === "sv_forms_session");

    const XSRF_TOKEN = decodeURIComponent(xsrf.value);
    const SESSION = session.value;

    const ranges = getLast6MonthRanges();

    for (const range of ranges) {
      console.log("Fetching:", range);
      let pageNo = 1;

      while (true) {
        const res = await page.request.post(
          `https://svform.urbanriseprojects.in/leadList?page=${pageNo}`,
          {
            headers: {
              "Content-Type": "application/json",
              "X-XSRF-TOKEN": XSRF_TOKEN,
              "Cookie": `XSRF-TOKEN=${XSRF_TOKEN}; sv_forms_session=${SESSION}`
            },
            data: {
              searchBy: "contact",
              dateFilter: range,
              project: PROJECT_ID
            }
          }
        );

        const json = await res.json();
        const rows = Object.values(json.data || {});

        for (const r of rows) {
          if (IS_FIRST_RUN || r.created_at > LAST_CREATED_AT) {
            recordsToSend.push({
              recent_site_visit_date: normalize(r.recent_date),
              name: normalize(r.first_name),
              contact: normalize(r.contact),
              lead_source: normalize(r.lead_source),
              lead_sub_source: normalize(r.lead_sub_source),
              lead_stage: normalize(r.lead_stage),
              lead_number: normalize(r.lead_number),
              created_at: normalize(r.created_at),
              updated_at: normalize(r.updated_at)
            });
          }
        }

        if (!json.next_page_url) break;
        pageNo++;
      }
    }

    console.log("TOTAL RECORDS:", recordsToSend.length);
    if (recordsToSend.length === 0) return;

    await fetch(VIASOCKET_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        meta: {
          source: "project_21_portal",
          project_id: PROJECT_ID,
          mode: IS_FIRST_RUN ? "6_month_backfill" : "2_hour_incremental",
          total_records: recordsToSend.length
        },
        records: recordsToSend
      })
    });

    const newest = recordsToSend
      .map(r => r.created_at)
      .sort()
      .slice(-1)[0];

    fs.writeFileSync(
      "cursor.json",
      JSON.stringify({ last_created_at: newest }, null, 2)
    );

    console.log("Cursor updated:", newest);

  } catch (err) {
    console.error(err.message);
    throw err;
  } finally {
    await browser.close();
  }
})();
