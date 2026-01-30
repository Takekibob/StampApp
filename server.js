const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const crypto = require("crypto");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "admin";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-session-secret";

const hasGoogleAuth = Boolean(
  GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_CALLBACK_URL
);

const dbDir = path.join(__dirname, "data");
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, "stamps.db");
const db = new sqlite3.Database(dbPath);

const runDb = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });

const getDb = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });

const allDb = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });

const nowIso = () => new Date().toISOString();

const normalizeMail = (value) => (value || "").trim().toLowerCase();
const normalizeUsername = (value) => (value || "").trim();

const clampStamps = (stamps) => Math.min(13, Math.max(0, stamps));

const getUserById = async (id) => {
  const row = await getDb(
    "SELECT id, stamps, isAdmin FROM users WHERE id = ?",
    [id]
  );
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    stamps: clampStamps(row.stamps),
    isAdmin: Boolean(row.isAdmin),
  };
};

const getOrCreateUser = async (id) => {
  const existing = await getUserById(id);
  if (existing) {
    return existing;
  }
  await runDb("INSERT INTO users (id, stamps, isAdmin) VALUES (?, 0, 0)", [
    id,
  ]);
  return { id, stamps: 0, isAdmin: false };
};

const getProfileByUserId = async (userId) => {
  const row = await getDb(
    "SELECT userId, username, mailAddress, description, job, hobbies, updatedAt FROM user_profiles WHERE userId = ?",
    [userId]
  );
  return row || null;
};

const getAuthIdentity = async (provider, providerKey) =>
  getDb(
    "SELECT id, userId, provider, providerKey FROM auth_identities WHERE provider = ? AND providerKey = ?",
    [provider, providerKey]
  );

const getPrimaryIdentityForUser = async (userId) =>
  getDb(
    "SELECT provider, providerKey FROM auth_identities WHERE userId = ? ORDER BY id ASC LIMIT 1",
    [userId]
  );

const ensureAdminUser = () => {
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

db.serialize(() => {
  db.run(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, stamps INTEGER NOT NULL DEFAULT 0, isAdmin INTEGER NOT NULL DEFAULT 0)"
  );

  db.run(
    "CREATE TABLE IF NOT EXISTS stamp_events (id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, createdAt TEXT NOT NULL, reason TEXT NOT NULL, eventType TEXT NOT NULL DEFAULT 'ADD', FOREIGN KEY(userId) REFERENCES users(id))"
  );

  db.run(
    "CREATE TABLE IF NOT EXISTS user_profiles (userId TEXT PRIMARY KEY, username TEXT, mailAddress TEXT, description TEXT, job TEXT, hobbies TEXT, updatedAt TEXT, FOREIGN KEY(userId) REFERENCES users(id))"
  );

  db.run(
    "CREATE TABLE IF NOT EXISTS auth_identities (id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, provider TEXT NOT NULL, providerKey TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(provider, providerKey), FOREIGN KEY(userId) REFERENCES users(id))"
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

  db.all("PRAGMA table_info(users)", (err, columns) => {
    if (err) {
      console.error("Failed to inspect users table:", err);
      return;
    }

    const hasIsAdmin = columns.some((column) => column.name === "isAdmin");

    if (!hasIsAdmin) {
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

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await getUserById(id);
    if (!user) {
      done(null, false);
      return;
    }
    done(null, { id: user.id });
  } catch (error) {
    done(error);
  }
});

if (hasGoogleAuth) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK_URL,
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const providerKey = profile.id;
          const existingIdentity = await getAuthIdentity("google", providerKey);
          if (existingIdentity) {
            done(null, { id: existingIdentity.userId });
            return;
          }
          const userId = crypto.randomUUID();
          const displayName = profile.displayName || "Googleユーザー";
          const email =
            Array.isArray(profile.emails) && profile.emails.length
              ? profile.emails[0].value
              : "";
          const createdAt = nowIso();
          await runDb(
            "INSERT INTO users (id, stamps, isAdmin) VALUES (?, 0, 0)",
            [userId]
          );
          await runDb(
            "INSERT INTO user_profiles (userId, username, mailAddress, description, job, hobbies, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [userId, displayName, email, "", "", "", createdAt]
          );
          await runDb(
            "INSERT INTO auth_identities (userId, provider, providerKey, createdAt) VALUES (?, ?, ?, ?)",
            [userId, "google", providerKey, createdAt]
          );
          done(null, { id: userId });
        } catch (error) {
          done(error);
        }
      }
    )
  );
}

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

const requireLoginPage = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    res.redirect("/login");
    return;
  }
  next();
};

const requireLoginApi = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  next();
};

const renderMessage = (message, type = "error") => {
  if (!message) {
    return "";
  }
  const className = type === "info" ? "notice" : "error";
  return `<div class="${className}" role="alert">${message}</div>`;
};

const renderAuthLinks = () => {
  return `<div class="auth-links">
    <a href="/signup">新規登録はこちら</a>
    <span class="divider">|</span>
    <a href="/login">ログインはこちら</a>
  </div>`;
};

const renderLoginPage = ({ errorMessage, infoMessage } = {}) => {
  const googleButton = hasGoogleAuth
    ? `<a class="button button--google" href="/auth/google">Googleでログイン</a>`
    : `<button class="button button--google" type="button" disabled>Googleログインは準備中</button>
       <div class="helper-text">.env の GOOGLE_* を設定すると有効になります。</div>`;
  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ログイン | 坐禅会スタンプカード</title>
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
        <h1>坐禅会スタンプカード</h1>
        <div class="subtle">ログインしてスタンプ状況を確認します。</div>
      </header>
      ${renderMessage(errorMessage)}
      ${renderMessage(infoMessage, "info")}
      <form action="/api/login" method="POST">
        <label>
          ユーザー名
          <input name="username" type="text" required placeholder="例: 法然" />
        </label>
        <label>
          メールアドレス
          <input name="mailAddress" type="email" required placeholder="example@example.com" />
        </label>
        <button type="submit">ログイン</button>
      </form>
      <div class="section-divider">または</div>
      <div class="oauth-block">
        ${googleButton}
      </div>
      ${renderAuthLinks()}
      <footer>はじめての方は新規登録を行ってください。</footer>
    </main>
  </body>
</html>`;
};

const renderSignupPage = ({ errorMessage, values = {} } = {}) => {
  const safe = (value) => (value ? String(value) : "");
  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>新規登録 | 坐禅会スタンプカード</title>
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
        <h1>新規登録</h1>
        <div class="subtle">プロフィールは後から編集できます。</div>
      </header>
      ${renderMessage(errorMessage)}
      <form action="/api/signup" method="POST">
        <label>
          ユーザー名
          <input name="username" type="text" required value="${safe(
            values.username
          )}" placeholder="例: 法然" />
        </label>
        <label>
          メールアドレス
          <input name="mailAddress" type="email" required value="${safe(
            values.mailAddress
          )}" placeholder="example@example.com" />
        </label>
        <label>
          ひとこと
          <textarea name="description" rows="3" placeholder="自由に記入してください">${safe(
            values.description
          )}</textarea>
        </label>
        <label>
          お仕事
          <input name="job" type="text" value="${safe(
            values.job
          )}" placeholder="例: 僧侶" />
        </label>
        <label>
          趣味（カンマ区切り）
          <input name="hobbies" type="text" value="${safe(
            values.hobbies
          )}" placeholder="例: 筋トレ, 坐禅, 読書" />
        </label>
        <button type="submit">登録してログイン</button>
      </form>
      ${renderAuthLinks()}
      <footer>メールアドレスは MVP では変更できません。</footer>
    </main>
  </body>
</html>`;
};

const renderProfilePage = ({
  profile,
  mailLocked = true,
  message,
  messageType = "info",
} = {}) => {
  const safe = (value) => (value ? String(value) : "");
  const mailValue = safe(profile ? profile.mailAddress : "");
  const mailInputAttrs = mailLocked
    ? "readonly aria-readonly=\"true\""
    : "";
  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>プロフィール | 坐禅会スタンプカード</title>
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
        <h1>プロフィール</h1>
        <div class="subtle">ログイン中ユーザーの情報を編集します。</div>
      </header>
      ${renderMessage(message, message ? messageType : undefined)}
      <form action="/api/profile" method="POST">
        <label>
          ユーザー名
          <input name="username" type="text" required value="${safe(
            profile ? profile.username : ""
          )}" />
        </label>
        <label>
          メールアドレス（MVPでは変更不可）
          <input name="mailAddress" type="email" value="${mailValue}" ${mailInputAttrs} />
        </label>
        <label>
          ひとこと
          <textarea name="description" rows="3">${safe(
            profile ? profile.description : ""
          )}</textarea>
        </label>
        <label>
          お仕事
          <input name="job" type="text" value="${safe(
            profile ? profile.job : ""
          )}" />
        </label>
        <label>
          趣味（カンマ区切り）
          <input name="hobbies" type="text" value="${safe(
            profile ? profile.hobbies : ""
          )}" placeholder="例: 筋トレ, 坐禅, 読書" />
        </label>
        <div class="form-actions">
          <button type="submit">保存</button>
          <a class="button button--ghost" href="/user">戻る</a>
        </div>
      </form>
      <footer>メールアドレス変更は将来機能です。</footer>
    </main>
  </body>
</html>`;
};

const renderUserPage = ({ userId, stamps, profile } = {}) => {
  const total = 13;
  const safeStamps = clampStamps(stamps || 0);
  const ringDots = Array.from({ length: total }, (_, index) => {
    return `<span class="ring-dot" style="--index:${index};" aria-hidden="true"></span>`;
  }).join("");
  const displayName = profile && profile.username ? profile.username : "";
  const job = profile && profile.job ? profile.job : "";
  const jobText = job ? `（${job}）` : "";
  const description = profile && profile.description ? profile.description : "";

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
        <div class="header-top">
          <div>
            <h1>坐禅会スタンプカード</h1>
            <div class="subtle" id="profile-summary">ようこそ ${displayName}${jobText}</div>
            <div class="subtle" id="profile-job">${description}</div>
          </div>
          <nav class="header-links">
            <a href="/profile">プロフィール</a>
            <a href="/logout">ログアウト</a>
          </nav>
        </div>
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
      const profileSummary = document.getElementById("profile-summary");
      const profileJob = document.getElementById("profile-job");
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

      const renderProfile = (profile = {}) => {
        const name = profile.username || "利用者";
        const job = profile.job ? "（" + profile.job + "）" : "";
        profileSummary.textContent = "ようこそ " + name + job;
        profileJob.textContent = profile.description ? profile.description : "";
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
        renderProfile(data.profile || {});

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
          const response = await fetch("/api/me");
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
          render({ ...data, lastUpdatedAt: data.lastUpdatedAt || new Date().toISOString(), recentEvents: [], profile: data.profile || {} }, currentStamps);
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

      render({ stamps: currentStamps, lastUpdatedAt: null, recentEvents: [], profile: {} });
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

app.get("/login", (req, res) => {
  const error = req.query.error;
  const info = req.query.info;
  let errorMessage = "";
  let infoMessage = "";
  if (error === "not_found") {
    errorMessage =
      "登録が見つかりませんでした。新規登録から作成してください。";
  } else if (error === "username_mismatch") {
    errorMessage = "ユーザー名が登録情報と一致しません。";
  } else if (error === "google") {
    errorMessage = "Googleログインに失敗しました。";
  }
  if (info === "logged_out") {
    infoMessage = "ログアウトしました。";
  }
  res.status(200).send(renderLoginPage({ errorMessage, infoMessage }));
});

app.get("/signup", (req, res) => {
  res.status(200).send(renderSignupPage());
});

app.get("/profile", requireLoginPage, async (req, res) => {
  try {
    let profile = await getProfileByUserId(req.session.userId);
    if (!profile) {
      const identity = await getPrimaryIdentityForUser(req.session.userId);
      profile = {
        username: "",
        mailAddress:
          identity && identity.provider === "local" ? identity.providerKey : "",
        description: "",
        job: "",
        hobbies: "",
      };
    }
    res.status(200).send(renderProfilePage({ profile, mailLocked: true }));
  } catch (error) {
    res.status(500).send("Internal Server Error");
  }
});

app.get("/user", requireLoginPage, async (req, res) => {
  try {
    const user = await getUserById(req.session.userId);
    if (!user) {
      res.status(404).send("User not found");
      return;
    }
    const profile = await getProfileByUserId(user.id);
    res.status(200).send(
      renderUserPage({ userId: user.id, stamps: user.stamps, profile })
    );
  } catch (error) {
    res.status(500).send("Internal Server Error");
  }
});

app.get("/logout", (req, res) => {
  if (req.session) {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.redirect("/login?info=logged_out");
    });
    return;
  }
  res.redirect("/login");
});

if (hasGoogleAuth) {
  app.get(
    "/auth/google",
    passport.authenticate("google", { scope: ["profile", "email"] })
  );

  app.get(
    "/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/login?error=google" }),
    (req, res) => {
      req.session.userId = req.user.id;
      res.redirect("/user");
    }
  );
} else {
  app.get("/auth/google", (req, res) => {
    res.status(500).send("Googleログインは設定されていません。");
  });
}

app.get("/admin", (req, res) => {
  res.status(200).send(renderAdminPage());
});

app.get("/api/me", requireLoginApi, async (req, res) => {
  try {
    const user = await getUserById(req.session.userId);
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    const profile = await getProfileByUserId(user.id);
    const lastUpdatedRow = await getDb(
      "SELECT MAX(createdAt) AS lastUpdatedAt FROM stamp_events WHERE userId = ?",
      [user.id]
    );
    const eventRows = await allDb(
      "SELECT eventType, reason, createdAt FROM stamp_events WHERE userId = ? ORDER BY createdAt DESC LIMIT 3",
      [user.id]
    );
    res.json({
      id: user.id,
      stamps: user.stamps,
      isAdmin: user.isAdmin,
      lastUpdatedAt: lastUpdatedRow ? lastUpdatedRow.lastUpdatedAt : null,
      recentEvents: eventRows || [],
      profile: profile
        ? {
            username: profile.username,
            mailAddress: profile.mailAddress,
            description: profile.description,
            job: profile.job,
            hobbies: profile.hobbies,
            updatedAt: profile.updatedAt,
          }
        : null,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to load user." });
  }
});

app.get("/api/user/:id", requireLoginApi, async (req, res) => {
  if (req.params.id !== req.session.userId) {
    res.status(403).json({ error: "Forbidden." });
    return;
  }
  try {
    const user = await getUserById(req.params.id);
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    const lastUpdatedRow = await getDb(
      "SELECT MAX(createdAt) AS lastUpdatedAt FROM stamp_events WHERE userId = ?",
      [user.id]
    );
    const eventRows = await allDb(
      "SELECT eventType, reason, createdAt FROM stamp_events WHERE userId = ? ORDER BY createdAt DESC LIMIT 3",
      [user.id]
    );
    res.json({
      id: user.id,
      stamps: user.stamps,
      isAdmin: user.isAdmin,
      lastUpdatedAt: lastUpdatedRow ? lastUpdatedRow.lastUpdatedAt : null,
      recentEvents: eventRows || [],
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to load user." });
  }
});

app.post("/api/login", async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const mailAddress = normalizeMail(req.body.mailAddress);
  if (!username || !mailAddress) {
    res.redirect("/login?error=not_found");
    return;
  }
  try {
    const identity = await getAuthIdentity("local", mailAddress);
    if (!identity) {
      res.redirect("/login?error=not_found");
      return;
    }
    const profile = await getProfileByUserId(identity.userId);
    if (profile && normalizeUsername(profile.username) !== username) {
      res.redirect("/login?error=username_mismatch");
      return;
    }
    req.session.userId = identity.userId;
    res.redirect("/user");
  } catch (error) {
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/signup", async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const mailAddressRaw = req.body.mailAddress || "";
  const mailAddress = normalizeMail(mailAddressRaw);
  const description = req.body.description || "";
  const job = req.body.job || "";
  const hobbies = req.body.hobbies || "";

  if (!username || !mailAddress) {
    res
      .status(400)
      .send(renderSignupPage({
        errorMessage: "ユーザー名とメールアドレスは必須です。",
        values: { username, mailAddress: mailAddressRaw, description, job, hobbies },
      }));
    return;
  }

  try {
    const existing = await getAuthIdentity("local", mailAddress);
    if (existing) {
      res
        .status(409)
        .send(renderSignupPage({
          errorMessage: "すでに登録済みのメールアドレスです。ログインしてください。",
          values: { username, mailAddress: mailAddressRaw, description, job, hobbies },
        }));
      return;
    }

    const userId = crypto.randomUUID();
    const createdAt = nowIso();

    await runDb(
      "INSERT INTO users (id, stamps, isAdmin) VALUES (?, 0, 0)",
      [userId]
    );
    await runDb(
      "INSERT INTO user_profiles (userId, username, mailAddress, description, job, hobbies, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [userId, username, mailAddress, description, job, hobbies, createdAt]
    );
    await runDb(
      "INSERT INTO auth_identities (userId, provider, providerKey, createdAt) VALUES (?, ?, ?, ?)",
      [userId, "local", mailAddress, createdAt]
    );

    req.session.userId = userId;
    res.redirect("/user");
  } catch (error) {
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/profile", requireLoginApi, async (req, res) => {
  try {
    const profile = await getProfileByUserId(req.session.userId);
    const username = normalizeUsername(req.body.username);
    const mailAddressInput = normalizeMail(req.body.mailAddress || "");
    const description = req.body.description || "";
    const job = req.body.job || "";
    const hobbies = req.body.hobbies || "";
    const baseProfile = profile || {
      mailAddress: mailAddressInput,
      description,
      job,
      hobbies,
      username,
    };

    if (!username) {
      res
        .status(400)
        .send(
          renderProfilePage({
            profile: { ...baseProfile, username, description, job, hobbies },
            message: "ユーザー名は必須です。",
            messageType: "error",
          })
        );
      return;
    }

    if (profile && profile.mailAddress && mailAddressInput) {
      const existingNormalized = normalizeMail(profile.mailAddress);
      if (existingNormalized !== mailAddressInput) {
        res
          .status(400)
          .send(
            renderProfilePage({
              profile: {
                ...baseProfile,
                username,
                description,
                job,
                hobbies,
              },
              message: "メールアドレスは変更できません。",
              messageType: "error",
            })
          );
        return;
      }
    }

    const nextMail = profile && profile.mailAddress
      ? profile.mailAddress
      : mailAddressInput;
    const updatedAt = nowIso();

    if (profile) {
      await runDb(
        "UPDATE user_profiles SET username = ?, description = ?, job = ?, hobbies = ?, updatedAt = ? WHERE userId = ?",
        [username, description, job, hobbies, updatedAt, req.session.userId]
      );
    } else {
      await runDb(
        "INSERT INTO user_profiles (userId, username, mailAddress, description, job, hobbies, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          req.session.userId,
          username,
          nextMail,
          description,
          job,
          hobbies,
          updatedAt,
        ]
      );
    }

    res.status(200).send(
      renderProfilePage({
        profile: {
          username,
          mailAddress: nextMail,
          description,
          job,
          hobbies,
        },
        mailLocked: true,
        message: "保存しました。",
        messageType: "info",
      })
    );
  } catch (error) {
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/admin/stamp", adminGuard, (req, res) => {
  const userId = req.body.userId;
  if (!userId) {
    res.status(400).json({ error: "userId is required." });
    return;
  }

  db.serialize(() => {
    db.run("INSERT OR IGNORE INTO users (id, stamps) VALUES (?, 0)", [
      userId,
    ]);
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

app.post("/api/reset", requireLoginApi, async (req, res) => {
  const userId = req.session.userId;
  if (req.body.userId && req.body.userId !== userId) {
    res.status(403).json({ error: "User mismatch." });
    return;
  }
  try {
    const user = await getUserById(userId);
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }
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
