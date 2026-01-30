const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "admin";

const dbDir = path.join(__dirname, "data");
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, "stamps.db");
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, stamps INTEGER NOT NULL DEFAULT 0, isAdmin INTEGER NOT NULL DEFAULT 0)"
  );

  db.run(
    "CREATE TABLE IF NOT EXISTS stamp_events (id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, createdAt TEXT NOT NULL, reason TEXT NOT NULL, eventType TEXT NOT NULL DEFAULT 'ADD', FOREIGN KEY(userId) REFERENCES users(id))"
  );

  db.all("PRAGMA table_info(stamp_events)", (err, columns) => {
    if (err) {
      console.error("Failed to inspect stamp_events table:", err);
      return;
    }
    const hasEventType = columns.some((column) => column.name === "eventType");
    if (!hasEventType) {
      db.run(
        "ALTER TABLE stamp_events ADD COLUMN eventType TEXT NOT NULL DEFAULT 'ADD'",
        (alterErr) => {
          if (alterErr) {
            console.error("Failed to add eventType column:", alterErr);
          }
        }
      );
    }
  });

  // ① まずスキーマ確認
  db.all("PRAGMA table_info(users)", (err, columns) => {
    if (err) {
      console.error("Failed to inspect users table:", err);
      return;
    }

    const hasIsAdmin = columns.some((column) => column.name === "isAdmin");

    const ensureAdminUser = () => {
      // ③ isAdmin列が存在する状態で admin を作る
      db.run(
        "INSERT OR IGNORE INTO users (id, stamps, isAdmin) VALUES (?, 0, 1)",
        [ADMIN_USER_ID],
        (insertErr) => {
          if (insertErr) {
            console.error("Failed to ensure admin user:", insertErr);
          }
        }
      );
    };

    if (!hasIsAdmin) {
      // ② 列が無ければ追加 → 終わったら admin作成
      db.run(
        "ALTER TABLE users ADD COLUMN isAdmin INTEGER NOT NULL DEFAULT 0",
        (alterErr) => {
          if (alterErr) {
            console.error("Failed to add isAdmin column:", alterErr);
            return;
          }
          ensureAdminUser();
        }
      );
    } else {
      ensureAdminUser();
    }
  });
});


app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const clampStamps = (stamps) => Math.min(13, Math.max(0, stamps));

const getUser = (id) =>
  new Promise((resolve, reject) => {
    db.get(
      "SELECT id, stamps, isAdmin FROM users WHERE id = ?",
      [id],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        if (row) {
          resolve({
            id: row.id,
            stamps: clampStamps(row.stamps),
            isAdmin: Boolean(row.isAdmin),
          });
          return;
        }
        db.run(
          "INSERT INTO users (id, stamps, isAdmin) VALUES (?, 0, 0)",
          [id],
          (insertErr) => {
            if (insertErr) {
              reject(insertErr);
              return;
            }
            resolve({ id, stamps: 0, isAdmin: false });
          }
        );
      }
    );
  });

const adminGuard = (req, res, next) => {
  if (!ADMIN_TOKEN) {
    res.status(500).json({ error: "ADMIN_TOKEN is not configured." });
    return;
  }
  const token = req.header("x-admin-token") || "";
  if (token !== ADMIN_TOKEN) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  next();
};

const renderUserPage = ({ userId, stamps }) => {
  const total = 13;
  const safeStamps = clampStamps(stamps);
  const ringDots = Array.from({ length: total }, (_, index) => {
    return `<span class="ring-dot" style="--index:${index};" aria-hidden="true"></span>`;
  }).join("");

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
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main data-user-id="${userId}" data-stamps="${safeStamps}">
      <header>
        <h1>坐禅会スタンプカード</h1>
        <div class="subtle">利用者: ${userId}</div>
      </header>
      <section class="ring-card" aria-label="スタンプ進捗リング">
        <div class="ring-wrapper">
          <svg class="progress-ring" viewBox="0 0 260 260" aria-hidden="true">
            <circle class="ring-track" cx="130" cy="130" r="110"></circle>
            <circle class="ring-progress" cx="130" cy="130" r="110"></circle>
          </svg>
          <div class="ring-dots">
            ${ringDots}
          </div>
          <div class="ring-center">
            <div class="center-count" id="center-count">${safeStamps} / 13</div>
            <button class="reset-button" id="reset-button" type="button" hidden>
              果報をうける
            </button>
          </div>
        </div>
        <div class="actions">
          <button class="refresh-button" id="refresh-button" type="button">更新</button>
        </div>
        <div class="toast" id="milestone-toast" role="status" aria-live="polite"></div>
      </section>
      <section class="update-info" aria-live="polite">
        <div id="last-updated">最終更新: --</div>
        <h2>直近3件</h2>
        <ul class="event-list" id="recent-events"></ul>
      </section>
      <footer>
        静かな積み重ねを記録するカードです。
      </footer>
    </main>
    <script>
      const TOTAL_STAMPS = 13;
      const main = document.querySelector("main");
      const userId = main.dataset.userId;
      const initialStamps = Number(main.dataset.stamps || 0);
      const centerCount = document.getElementById("center-count");
      const resetButton = document.getElementById("reset-button");
      const refreshButton = document.getElementById("refresh-button");
      const lastUpdated = document.getElementById("last-updated");
      const recentEvents = document.getElementById("recent-events");
      const milestoneToast = document.getElementById("milestone-toast");
      const dots = Array.from(document.querySelectorAll(".ring-dot"));
      const progressCircle = document.querySelector(".ring-progress");
      const ringRadius = Number(progressCircle.getAttribute("r"));
      const ringCircumference = 2 * Math.PI * ringRadius;
      progressCircle.style.strokeDasharray = ringCircumference;
      progressCircle.style.strokeDashoffset = ringCircumference;

      let lastUpdatedAt;
      let currentStamps = initialStamps;
      let toastTimer = null;

      const clamp = (value) => Math.min(TOTAL_STAMPS, Math.max(0, Number(value) || 0));

      const formatDateTime = (iso) => {
        if (!iso) {
          return "未更新";
        }
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) {
          return iso;
        }
        return date.toLocaleString("ja-JP", { hour12: false });
      };

      const setToast = (message) => {
        milestoneToast.textContent = message;
        milestoneToast.classList.add("toast--show");
        if (toastTimer) {
          clearTimeout(toastTimer);
        }
        toastTimer = setTimeout(() => {
          milestoneToast.classList.remove("toast--show");
        }, 3000);
      };

      const renderEvents = (events = []) => {
        recentEvents.innerHTML = "";
        if (!events.length) {
          const empty = document.createElement("li");
          empty.className = "event-item";
          empty.textContent = "履歴はまだありません。";
          recentEvents.appendChild(empty);
          return;
        }
        events.forEach((event) => {
          const item = document.createElement("li");
          item.className = "event-item";
          item.textContent = event.eventType + " / " + event.reason + " / " + formatDateTime(event.createdAt);
          recentEvents.appendChild(item);
        });
      };

      const render = (data, previousStamps) => {
        const stamps = clamp(data.stamps);
        const progress = stamps / TOTAL_STAMPS;
        const offset = ringCircumference * (1 - progress);
        progressCircle.style.strokeDashoffset = offset;
        dots.forEach((dot, index) => {
          dot.classList.toggle("ring-dot--filled", index < stamps);
        });
        centerCount.textContent = stamps + " / " + TOTAL_STAMPS;
        if (stamps >= TOTAL_STAMPS) {
          centerCount.hidden = true;
          resetButton.hidden = false;
        } else {
          centerCount.hidden = false;
          resetButton.hidden = true;
        }
        lastUpdated.textContent = "最終更新: " + formatDateTime(data.lastUpdatedAt);
        renderEvents(data.recentEvents || []);

        if (typeof previousStamps === "number") {
          const milestones = [5, 10];
          milestones.forEach((value) => {
            const storageKey = "milestone_shown_" + value + "_" + userId;
            if (previousStamps < value && stamps >= value && !localStorage.getItem(storageKey)) {
              localStorage.setItem(storageKey, "true");
              setToast(value + "個到達しました。");
            }
          });
        }

        currentStamps = stamps;
        lastUpdatedAt = data.lastUpdatedAt || null;
      };

      const setRefreshState = (loading) => {
        refreshButton.disabled = loading;
        refreshButton.textContent = loading ? "更新中..." : "更新";
      };

      const fetchStatus = async ({ forceRender = false, showLoading = false } = {}) => {
        if (showLoading) {
          setRefreshState(true);
        }
        try {
          const response = await fetch("/api/user/" + encodeURIComponent(userId));
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || "Failed to fetch status.");
          }
          const shouldRender =
            forceRender ||
            typeof lastUpdatedAt === "undefined" ||
            data.lastUpdatedAt !== lastUpdatedAt;
          if (shouldRender) {
            render(data, currentStamps);
          } else {
            currentStamps = clamp(data.stamps);
            lastUpdatedAt = data.lastUpdatedAt || null;
          }
        } catch (error) {
          if (showLoading) {
            alert("更新に失敗しました。");
          }
        } finally {
          if (showLoading) {
            setRefreshState(false);
          }
        }
      };

      resetButton.addEventListener("click", async () => {
        resetButton.disabled = true;
        resetButton.textContent = "処理中...";
        try {
          const response = await fetch("/api/reset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId }),
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || "Failed to reset.");
          }
          render({ ...data, lastUpdatedAt: data.lastUpdatedAt || new Date().toISOString(), recentEvents: [] }, currentStamps);
          await fetchStatus({ forceRender: true });
        } catch (error) {
          alert("リセットに失敗しました。");
        } finally {
          resetButton.disabled = false;
          resetButton.textContent = "果報をうける";
        }
      });

      refreshButton.addEventListener("click", () => {
        fetchStatus({ forceRender: true, showLoading: true });
      });

      render({ stamps: currentStamps, lastUpdatedAt: null, recentEvents: [] });
      fetchStatus({ forceRender: true });
      setInterval(() => {
        fetchStatus();
      }, 5000);
    </script>
  </body>
</html>`;
};

const renderAdminPage = () => `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>管理者スタンプ付与</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;600&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main>
      <header>
        <h1>管理者スタンプ付与</h1>
        <div class="subtle">管理者ID: ${ADMIN_USER_ID}</div>
      </header>
      <form id="stamp-form">
        <label>
          対象ユーザーID
          <input name="userId" type="text" required placeholder="user-001" />
        </label>
        <label>
          管理者トークン
          <input name="token" type="password" required placeholder="ADMIN_TOKEN" />
        </label>
        <button type="submit">スタンプを付与する</button>
      </form>
      <div class="result" id="result" aria-live="polite">
        <span class="subtle">入力を送信すると結果が表示されます。</span>
      </div>
      <footer>管理者 API を通じてスタンプを付与します。</footer>
    </main>
    <script>
      const form = document.getElementById("stamp-form");
      const result = document.getElementById("result");

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const userId = formData.get("userId");
        const token = formData.get("token");
        result.innerHTML = "<span class=\\"subtle\\">処理中...</span>";
        try {
          const response = await fetch("/api/admin/stamp", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-admin-token": token,
            },
            body: JSON.stringify({ userId }),
          });
          const data = await response.json();
          if (!response.ok) {
            result.innerHTML = "<span class=\\"error\\">" + data.error + "</span>";
            return;
          }
          result.innerHTML =
            "現在のスタンプ数: <strong>" + data.stamps + "</strong> / 13";
        } catch (error) {
          result.innerHTML =
            "<span class=\\"error\\">通信に失敗しました。</span>";
        }
      });
    </script>
  </body>
</html>`;

app.get("/", (req, res) => {
  res.redirect("/user");
});

const parseCookies = (req) => {
  const header = req.headers.cookie || "";
  return header.split(";").reduce((acc, pair) => {
    const trimmed = pair.trim();
    if (!trimmed) {
      return acc;
    }
    const index = trimmed.indexOf("=");
    if (index === -1) {
      return acc;
    }
    const key = decodeURIComponent(trimmed.slice(0, index));
    const value = decodeURIComponent(trimmed.slice(index + 1));
    acc[key] = value;
    return acc;
  }, {});
};

// app.get("/user", async (req, res) => {
//   const requestedUserId = req.query.user || "guest";
//   const cookies = parseCookies(req);
//   const lockedUserId = cookies.stampUserId || requestedUserId;
//   if (!cookies.stampUserId) {
//     res.setHeader(
//       "Set-Cookie",
//       `stampUserId=${encodeURIComponent(lockedUserId)}; Path=/; SameSite=Lax`
//     );
//   }
//   try {
//     const user = await getUser(lockedUserId);
//     res.status(200).send(
//       renderUserPage({ userId: user.id, stamps: user.stamps })
//     );
//   } catch (error) {
//     res.status(500).send("Internal Server Error");
//   }
// });

app.get("/user", async (req, res) => {
  const cookies = parseCookies(req);

  // クエリで user が指定されたら、それを優先して Cookie も更新（=ユーザー切替）
  const queryUserId = typeof req.query.user === "string" ? req.query.user : "";
  const hasQuery = Boolean(queryUserId);

  const userId = hasQuery
    ? queryUserId
    : (cookies.stampUserId || "guest");

  // Cookie が無い場合 or クエリ指定で切替が発生した場合は Cookie を更新
  if (!cookies.stampUserId || hasQuery) {
    res.setHeader(
      "Set-Cookie",
      `stampUserId=${encodeURIComponent(userId)}; Path=/; SameSite=Lax`
    );
  }

  try {
    const user = await getUser(userId);
    res.status(200).send(renderUserPage({ userId: user.id, stamps: user.stamps }));
  } catch (error) {
    res.status(500).send("Internal Server Error");
  }
});


app.get("/admin", (req, res) => {
  res.status(200).send(renderAdminPage());
});

app.get("/api/user/:id", async (req, res) => {
  try {
    const user = await getUser(req.params.id);
    db.get(
      "SELECT MAX(createdAt) AS lastUpdatedAt FROM stamp_events WHERE userId = ?",
      [user.id],
      (lastUpdatedErr, lastUpdatedRow) => {
        if (lastUpdatedErr) {
          res.status(500).json({ error: "Failed to load user status." });
          return;
        }
        db.all(
          "SELECT eventType, reason, createdAt FROM stamp_events WHERE userId = ? ORDER BY createdAt DESC LIMIT 3",
          [user.id],
          (eventsErr, eventRows) => {
            if (eventsErr) {
              res.status(500).json({ error: "Failed to load user status." });
              return;
            }
            res.json({
              id: user.id,
              stamps: user.stamps,
              isAdmin: user.isAdmin,
              lastUpdatedAt: lastUpdatedRow ? lastUpdatedRow.lastUpdatedAt : null,
              recentEvents: eventRows || [],
            });
          }
        );
      }
    );
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
            const safeStamps = clampStamps(row.stamps);
            db.run(
              "INSERT INTO stamp_events (userId, createdAt, reason, eventType) VALUES (?, ?, ?, ?)",
              [userId, new Date().toISOString(), "admin_grant", "ADD"]
            );
            res.json({ id: row.id, stamps: safeStamps });
          }
        );
      }
    );
  });
});

app.post("/api/reset", async (req, res) => {
  const cookies = parseCookies(req);
  const userId = cookies.stampUserId;
  if (!userId) {
    res.status(401).json({ error: "User is not identified." });
    return;
  }
  if (req.body.userId && req.body.userId !== userId) {
    res.status(403).json({ error: "User mismatch." });
    return;
  }
  try {
    await getUser(userId);
  } catch (error) {
    res.status(500).json({ error: "Failed to load user." });
    return;
  }
  db.serialize(() => {
    db.run("UPDATE users SET stamps = 0 WHERE id = ?", [userId], (err) => {
      if (err) {
        res.status(500).json({ error: "Failed to reset stamps." });
        return;
      }
      db.run(
        "INSERT INTO stamp_events (userId, createdAt, reason, eventType) VALUES (?, ?, ?, ?)",
        [userId, new Date().toISOString(), "user_reset", "RESET"]
      );
      res.json({ id: userId, stamps: 0 });
    });
  });
});

app.listen(PORT, () => {
  console.log(`Stamp app listening on http://localhost:${PORT}`);
});
