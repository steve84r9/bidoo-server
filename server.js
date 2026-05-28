import express from "express";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { chromium } from "playwright-core";

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------
// DATABASE
// ----------------------
let db;

async function initDB() {
  db = await open({
    filename: "./bidoo.db",
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS auctions (
      id INTEGER PRIMARY KEY,
      title TEXT,
      price REAL,
      raw_price TEXT,
      created_at TEXT
    )
  `);
}

// ----------------------
// SCRAPER PLAYWRIGHT (HEADLESS + ANTI-BOT COMPATIBILE)
// ----------------------
async function scrapeAuction(id) {
  const url = `https://it.bidoo.com/auction.php?a=${id}`;

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080"
    ]
  });

  const page = await browser.newPage();

  // VIEWPORT
  await page.setViewportSize({ width: 1920, height: 1080 });

  // USER AGENT
  await page.setExtraHTTPHeaders({
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept-Language": "it-IT,it;q=0.9"
  });

  // ANTI-BOT COMPATIBILE (senza addInitScript)
  await page.route("**/*", (route) => {
    const headers = {
      ...route.request().headers(),
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    };
    route.continue({ headers });
  });

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });
  } catch (err) {
    console.log("Goto failed for", id, err.message);
    await browser.close();
    return null;
  }

  const title = await page.title();
  if (!title) {
    console.log("Page failed:", id);
    await browser.close();
    return null;
  }

  const data = await page.evaluate(() => {
    const title = document.title.replace(" - Bidoo", "").trim();
    const priceEl = document.querySelector(".price-winner");
    const priceText = priceEl ? priceEl.textContent.trim() : "";
    return { title, priceText };
  });

  await browser.close();

  if (!data.title || !data.priceText) return null;

  const priceNum = parseFloat(
    data.priceText.replace("€", "").replace(".", "").replace(",", ".")
  );

  if (isNaN(priceNum)) return null;

  return {
    id,
    title: data.title,
    price: priceNum,
    raw_price: data.priceText,
    created_at: new Date().toISOString()
  };
}

// ----------------------
// SALVATAGGIO
// ----------------------
async function saveAuction(data) {
  await db.run(
    `INSERT OR REPLACE INTO auctions (id, title, price, raw_price, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [data.id, data.title, data.price, data.raw_price, data.created_at]
  );
}

// ----------------------
// ENDPOINT CRON
// ----------------------
app.get("/cron", async (req, res) => {
  let start = 91500000;
  let end = start + 30;

  for (let id = start; id <= end; id++) {
    console.log("DEBUG ID:", id);

    const result = await scrapeAuction(id);

    if (result) {
      await saveAuction(result);
      console.log("Saved:", result);
    } else {
      console.log("No data for", id);
    }
  }

  res.send("Cron completed.");
});

// ----------------------
// STATUS
// ----------------------
app.get("/", (req, res) => {
  res.send("Bidoo analyzer clone running (Docker).");
});

// ----------------------
// AVVIO SERVER
// ----------------------
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
