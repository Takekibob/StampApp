# 坐禅会スタンプカード（MVP）

坐禅会への参加ごとにスタンプが 1 つ増え、13 個で節目を迎えるシンプルなスタンプカードです。

## できること
- ログイン（username + mailAddress / Google）とログアウト
- プロフィール登録（ユーザー名・メールアドレス・ひとこと・お仕事・趣味）
- ユーザー画面で 13 個のスタンプをリング状に表示し、進捗リングで達成状況を可視化
- リング中央に「X / 13」または「果報をうける」ボタンを表示
- 5 個 / 10 個到達時に一度だけ軽い演出を表示（ユーザー単位で localStorage 管理）
- ユーザー画面の更新ボタンで最新状態を取得し、5 秒ごとのポーリングで自動反映
- リング下に「最終更新」と「直近 3 件の履歴」を表示
- 管理者画面で特定ユーザーにスタンプを +1 付与（上限 13）
- 管理者 API で特定ユーザーにスタンプを +1 付与（上限 13）
- SQLite にユーザー ID / プロフィール / ログイン手段 / スタンプ履歴を永続化

## セットアップ

```bash
npm install
```

### 環境変数

管理者 API とログイン機能用の値を `.env` に設定してください。

```bash
cat <<EOF > .env
ADMIN_TOKEN=your-secret-token
ADMIN_USER_ID=admin
SESSION_SECRET=your-session-secret
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
EOF
```

- `GOOGLE_*` は Google ログインを使う場合のみ必須です。
- `SESSION_SECRET` はログインセッションを保護するために必要です。

### 起動

```bash
npm run dev
```

ブラウザで `http://localhost:3000/login` を開くとログイン画面を確認できます。
管理者画面は `http://localhost:3000/admin` です。

## MVP 前提の注意事項（必須）
- username + mailAddress ログインは本人確認が弱く、なりすまし耐性がありません（将来は Magic Link / OTP へ移行予定）。
- Google OAuth はメモリセッションストアを使用しています。本番では永続ストアが必要です。
- local と google アカウントは自動統合しません（将来はアカウント連携で統合予定）。
- mailAddress 変更は MVP 対象外です（将来対応）。
- HTTPS 運用時は Cookie の `secure=true` を推奨します。

## 画面

- `/login`: ログイン画面
- `/signup`: 新規登録
- `/profile`: プロフィール編集（ログイン必須）
- `/user`: スタンプカード（ログイン必須）
- `/admin`: 管理者画面

## API

- `GET /api/me`: ログイン中ユーザーのスタンプ状況 + プロフィール
- `POST /api/login`: username + mailAddress でログイン
- `POST /api/signup`: 新規登録（local）
- `POST /api/profile`: プロフィール保存
- `POST /api/reset`: ログイン中ユーザーのスタンプを 0 にリセット
- `GET /api/user/:id`: ログイン中ユーザー自身のみ取得可能
- `POST /api/admin/stamp`: 指定ユーザーにスタンプを +1 付与（上限 13）

### 管理者 API（スタンプ付与）

```bash
curl -X POST http://localhost:3000/api/admin/stamp \
  -H "Content-Type: application/json" \
  -H "x-admin-token: your-secret-token" \
  -d '{"userId":"your-id"}'
```

### `GET /api/me` のレスポンス例

```json
{
  "id": "user-uuid",
  "stamps": 4,
  "isAdmin": false,
  "lastUpdatedAt": "2024-06-01T12:34:56.000Z",
  "recentEvents": [
    { "eventType": "ADD", "reason": "admin_grant", "createdAt": "2024-06-01T12:34:56.000Z" }
  ],
  "profile": {
    "username": "法然",
    "mailAddress": "example@example.com",
    "description": "初めての坐禅会です",
    "job": "僧侶",
    "hobbies": "筋トレ, 坐禅, 読書",
    "updatedAt": "2024-06-01T12:34:56.000Z"
  }
}
```

## UI 仕様メモ

- リングは 12 時方向を起点に時計回りで 0〜12 のスタンプを配置
- 5 秒ポーリングで `lastUpdatedAt` が変わった場合のみ再描画
- 更新情報はリング直下に「最終更新」「直近 3 件」の順で表示

## DB スキーマ

SQLite: `data/stamps.db`

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  stamps INTEGER NOT NULL DEFAULT 0,
  isAdmin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stamp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  reason TEXT NOT NULL,
  eventType TEXT NOT NULL DEFAULT 'ADD'
);

CREATE TABLE user_profiles (
  userId TEXT PRIMARY KEY,
  username TEXT,
  mailAddress TEXT,
  description TEXT,
  job TEXT,
  hobbies TEXT,
  updatedAt TEXT
);

CREATE TABLE auth_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL,
  provider TEXT NOT NULL,
  providerKey TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE(provider, providerKey)
);
```
