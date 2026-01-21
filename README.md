# 坐禅会スタンプカード（MVP）

坐禅会への参加ごとにスタンプが 1 つ増え、13 個で節目を迎えるシンプルなスタンプカードです。

## できること
- ユーザー画面で 0〜13 のスタンプ枠と現在数を表示
- 13 個到達時に静かな節目表示
- 管理者 API で特定ユーザーにスタンプを +1 付与（上限 13）
- SQLite にユーザー ID とスタンプ数を永続化

## セットアップ

```bash
npm install
```

### 環境変数

管理者 API 用のトークンを設定してください。

```bash
export ADMIN_TOKEN="your-secret-token"
```

### 起動

```bash
npm run dev
```

ブラウザで `http://localhost:3000/?user=your-id` を開くとユーザー画面を確認できます。

## 管理者操作（スタンプ付与）

```bash
curl -X POST http://localhost:3000/api/admin/stamp \
  -H "Content-Type: application/json" \
  -H "x-admin-token: your-secret-token" \
  -d '{"userId":"your-id"}'
```

## API

- `GET /?user=<id>`: スタンプカード画面を表示
- `GET /api/user/:id`: ユーザーの現在スタンプ数を取得
- `POST /api/admin/stamp`: 指定ユーザーにスタンプを +1 付与（上限 13）

## DB スキーマ

SQLite: `data/stamps.db`

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  stamps INTEGER NOT NULL DEFAULT 0
);
```

## MVP 前提の補足（仮定）
- 認証は管理者 API に `ADMIN_TOKEN` を付与する簡易方式
- ユーザー識別は URL クエリ `?user=` を利用
