import express from "express";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

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
// SCRAPER API (NO BROWSER)
// ----------------------
async function scrapeAuction(id) {
  const url = `https://it.bidoo.com/data.php?ALL=${id}&LISTID=0`;

  try {
    const res = await fetch(url);
    const json = await res.json();

    // Se non esiste l'asta
    if (!json || !json.data || !json.data[id]) {
      console.log("No data for", id);
      return null;
    }

    const a = json.data[id];

    return {
      id,
      title: a.title || "",
      price: parseFloat(a.price || 0),
      raw_price: a.price || "",
      created_at: new Date().toISOString()
    };

  } catch (err) {
    console.log("API error for", id, err.message);
    return null;
  }
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
    }
  }

  res.send("Cron completed.");
});

// ----------------------
// STATUS
// ----------------------
app.get("/", (req, res) => {
  res.send("Bidoo analyzer clone running (API mode).");
});

// ----------------------
// AVVIO SERVER
// ----------------------
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
