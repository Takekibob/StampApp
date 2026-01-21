const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const dbDir = path.join(__dirname, "data");
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, "stamps.db");
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, stamps INTEGER NOT NULL DEFAULT 0)"
  );
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const getUser = (id) =>
  new Promise((resolve, reject) => {
    db.get("SELECT id, stamps FROM users WHERE id = ?", [id], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      if (row) {
        resolve(row);
        return;
      }
      db.run(
        "INSERT INTO users (id, stamps) VALUES (?, 0)",
        [id],
        (insertErr) => {
          if (insertErr) {
            reject(insertErr);
            return;
          }
          resolve({ id, stamps: 0 });
        }
      );
    });
  });

const adminGuard = (req, res, next) => {
  if (!ADMIN_TOKEN) {
    res.status(500).json({ error: "ADMIN_TOKEN is not configured." });
    return;
  }
  const token = req.header("x-admin-token") || req.body?.token || "";
  if (token !== ADMIN_TOKEN) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  next();
};

const renderPage = ({ userId, stamps }) => {
  const total = 13;
  const stampItems = Array.from({ length: total }, (_, index) => {
    const filled = index < stamps;
    return `<li class="stamp ${filled ? "stamp--filled" : ""}" aria-hidden="true"></li>`;
  }).join("");

  const milestoneMessage =
    stamps >= total
      ? "<p class=\"milestone\">節目を迎えました</p>"
      : "<p class=\"milestone muted\">静かに積み重ねています</p>";

  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>坐禅会スタンプカード</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;600&display=swap"
      rel="stylesheet"
    />
    <style>
      :root {
        color-scheme: light;
        --paper: #f6f1e7;
        --ink: #2f2a24;
        --wood: #8a6f4d;
        --accent: #6b5a46;
        --border: #d2c7b8;
        --stamp-fill: #3a2f27;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: "Noto Serif JP", serif;
        background: var(--paper);
        color: var(--ink);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 48px 20px;
      }
      main {
        width: min(720px, 100%);
        background: rgba(255, 255, 255, 0.7);
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 36px;
        box-shadow: 0 16px 30px rgba(0, 0, 0, 0.08);
      }
      header {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 24px;
      }
      h1 {
        font-size: 1.6rem;
        margin: 0;
        letter-spacing: 0.05em;
      }
      .subtle {
        font-size: 0.95rem;
        color: #5d5246;
      }
      .count {
        display: inline-flex;
        align-items: baseline;
        gap: 8px;
        padding: 10px 16px;
        background: #fefaf2;
        border: 1px solid var(--border);
        border-radius: 999px;
        font-weight: 600;
      }
      .count strong {
        font-size: 1.4rem;
        color: var(--accent);
      }
      .stamp-grid {
        list-style: none;
        padding: 0;
        margin: 24px 0 0;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(56px, 1fr));
        gap: 16px;
      }
      .stamp {
        width: 56px;
        height: 56px;
        border-radius: 50%;
        border: 2px dashed var(--wood);
        background: transparent;
        position: relative;
      }
      .stamp--filled {
        border-style: solid;
        background: radial-gradient(circle at 30% 30%, #6c5646, var(--stamp-fill));
        box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.2);
      }
      .milestone {
        margin: 18px 0 0;
        font-size: 1rem;
        color: var(--accent);
      }
      .milestone.muted {
        color: #6b6258;
      }
      footer {
        margin-top: 28px;
        font-size: 0.85rem;
        color: #75695c;
      }
      .note {
        border-top: 1px solid var(--border);
        padding-top: 16px;
      }
      @media (max-width: 560px) {
        main {
          padding: 24px;
        }
        .stamp-grid {
          grid-template-columns: repeat(auto-fit, minmax(48px, 1fr));
          gap: 12px;
        }
        .stamp {
          width: 48px;
          height: 48px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>坐禅会スタンプカード</h1>
        <div class="subtle">利用者: ${userId}</div>
        <div class="count"><strong>${stamps}</strong> / 13</div>
      </header>
      ${milestoneMessage}
      <ul class="stamp-grid" aria-label="スタンプの進捗">
        ${stampItems}
      </ul>
      <footer class="note">
        静かな積み重ねを記録するカードです。
      </footer>
    </main>
  </body>
</html>`;
};

app.get("/", async (req, res) => {
  const userId = req.query.user || "guest";
  try {
    const user = await getUser(userId);
    res.status(200).send(renderPage({ userId: user.id, stamps: user.stamps }));
  } catch (error) {
    res.status(500).send("Internal Server Error");
  }
});

app.get("/api/user/:id", async (req, res) => {
  try {
    const user = await getUser(req.params.id);
    res.json({ id: user.id, stamps: user.stamps });
  } catch (error) {
    res.status(500).json({ error: "Failed to load user." });
  }
});

app.post("/api/admin/stamp", adminGuard, (req, res) => {
  const userId = req.body.userId;
  if (!userId) {
    res.status(400).json({ error: "userId is required." });
    return;
  }

  db.serialize(() => {
    db.run(
      "INSERT OR IGNORE INTO users (id, stamps) VALUES (?, 0)",
      [userId]
    );
    db.run(
      "UPDATE users SET stamps = CASE WHEN stamps < 13 THEN stamps + 1 ELSE 13 END WHERE id = ?",
      [userId],
      function updateCallback(err) {
        if (err) {
          res.status(500).json({ error: "Failed to update stamp." });
          return;
        }
        db.get(
          "SELECT id, stamps FROM users WHERE id = ?",
          [userId],
          (getErr, row) => {
            if (getErr) {
              res.status(500).json({ error: "Failed to fetch user." });
              return;
            }
            res.json({ id: row.id, stamps: row.stamps });
          }
        );
      }
    );
  });
});

app.listen(PORT, () => {
  console.log(`Stamp app listening on http://localhost:${PORT}`);
});
