# 坐禅会スタンプカード（MVP）

坐禅会への参加ごとにスタンプが 1 つ増え、13 個で節目を迎えるシンプルなスタンプカードです。

## できること
- ユーザー画面で 13 個のスタンプをリング状に表示し、進捗リングで達成状況を可視化
- リング中央に「X / 13」または「果報をうける」ボタンを表示
- 5 個 / 10 個到達時に一度だけ軽い演出を表示（ユーザー単位で localStorage 管理）
- ユーザー画面の更新ボタンで最新状態を取得し、5 秒ごとのポーリングで自動反映
- リング下に「最終更新」と「直近 3 件の履歴」を表示
- 管理者画面で特定ユーザーにスタンプを +1 付与（上限 13）
- 管理者 API で特定ユーザーにスタンプを +1 付与（上限 13）
- SQLite にユーザー ID / スタンプ数 / 管理者フラグを永続化

## セットアップ

```bash
npm install
```

### 環境変数

管理者 API 用のトークンを `.env` に設定してください。

```bash
cat <<EOF > .env
ADMIN_TOKEN=your-secret-token
ADMIN_USER_ID=admin
EOF
```

### 起動

```bash
npm run dev
```

ブラウザで `http://localhost:3000/user?user=your-id` を開くとユーザー画面を確認できます。
管理者画面は `http://localhost:3000/admin` です。

## 管理者操作（画面 / API）

### 管理者画面
`/admin` でユーザー ID と管理者トークンを入力し、付与結果を確認できます。

### 管理者 API（スタンプ付与）

```bash
curl -X POST http://localhost:3000/api/admin/stamp \
  -H "Content-Type: application/json" \
  -H "x-admin-token: your-secret-token" \
  -d '{"userId":"your-id"}'
```

## API

- `GET /user?user=<id>`: ユーザー用スタンプカード画面を表示
- `GET /admin`: 管理者ページを表示
- `GET /api/user/:id`: ユーザーの現在スタンプ数 + 更新情報を取得
- `POST /api/admin/stamp`: 指定ユーザーにスタンプを +1 付与（上限 13）
- `POST /api/reset`: 現在のユーザーのスタンプを 0 にリセット

### `GET /api/user/:id` のレスポンス例

```json
{
  "id": "guest",
  "stamps": 4,
  "isAdmin": false,
  "lastUpdatedAt": "2024-06-01T12:34:56.000Z",
  "recentEvents": [
    { "eventType": "ADD", "reason": "admin_grant", "createdAt": "2024-06-01T12:34:56.000Z" }
  ]
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
```

## MVP 前提の補足（仮定）
- 認証は管理者 API に `ADMIN_TOKEN` を付与する簡易方式
- `isAdmin` は「管理者用のユーザーを区別する」ためのフラグとして利用し、API の最終的な認可は `ADMIN_TOKEN` で行う
- 初期管理者ユーザーは `ADMIN_USER_ID`（未指定時は `admin`）として作成される
- ユーザー識別は URL クエリ `?user=` を利用し、初回アクセス時に同じユーザー ID を cookie に固定する
