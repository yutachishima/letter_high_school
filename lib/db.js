/**
 * データベース（Neon / Postgres）への保存
 *
 * Vercel の Storage から Neon を接続すると、環境変数 DATABASE_URL が自動で設定されます。
 * テーブル（letters）は、最初に使われたときに自動で作られます。手作業は不要です。
 *
 * 1回の利用（写真2枚の読み取り → 確認・修正 → 返信）で、1行のデータになります。
 *   1. 写真を読み取った時点で行を作り、AIの読み取り結果（ai_〜）を保存
 *   2. 本人が確認・修正した内容（age 〜 letter）を保存
 *   3. AIの返信（reply）を保存
 * 写真そのものは保存しません。
 */

import { neon } from '@neondatabase/serverless';
import { AppError, PROFILE_KEYS } from './common.js';

let sqlClient = null;
let tableReady = null;

/** 接続先。Neon を接続したときに入る環境変数を探す */
function connectionString() {
  const direct = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (direct) return direct;

  // 接続するときに「Custom Prefix」を付けた場合（例: STORAGE_DATABASE_URL）にも対応する
  const key = Object.keys(process.env).find(
    k => /_(DATABASE_URL|POSTGRES_URL)$/.test(k) && process.env[k]
  );
  return key ? process.env[key] : '';
}

export function assertDatabaseConfigured() {
  if (!connectionString()) {
    throw new AppError(
      'データベースが接続されていません。Vercel の Storage で Neon をこのプロジェクトに接続し、再デプロイしてください（環境変数 DATABASE_URL）。',
      500
    );
  }
}

function sql() {
  if (!sqlClient) {
    assertDatabaseConfigured();
    sqlClient = neon(connectionString());
  }
  return sqlClient;
}

/** テーブルがなければ作る（関数が起動して最初の1回だけ実行） */
export function ensureTable() {
  if (!tableReady) {
    tableReady = createTable().catch(err => {
      tableReady = null; // 失敗したら次回やり直す
      throw err;
    });
  }
  return tableReady;
}

async function createTable() {
  try {
    await sql()`
      CREATE TABLE IF NOT EXISTS letters (
        id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

        ai_age           TEXT,
        ai_occupation    TEXT,
        ai_residence     TEXT,
        ai_appearance    TEXT,
        ai_personality   TEXT,
        ai_activities    TEXT,
        ai_relationships TEXT,
        ai_letter        TEXT,
        read_model       TEXT,

        age              TEXT,
        occupation       TEXT,
        residence        TEXT,
        appearance       TEXT,
        personality      TEXT,
        activities       TEXT,
        relationships    TEXT,
        letter           TEXT,
        confirmed_at     TIMESTAMPTZ,

        reply            TEXT,
        reply_model      TEXT,
        replied_at       TIMESTAMPTZ,

        edit_token       UUID NOT NULL DEFAULT gen_random_uuid()
      )`;
  } catch (err) {
    // 複数の関数が同時にテーブルを作ろうとした場合は、どちらかが作れていれば問題ない
    if (err?.code === '42P07' || err?.code === '23505') return;
    throw err;
  }
}

/** 1. 写真を読み取った結果を保存して、番号と合言葉を返す */
export async function insertReading({ profile, letter, model }) {
  await ensureTable();
  const p = pick(profile);
  const rows = await sql()`
    INSERT INTO letters (
      ai_age, ai_occupation, ai_residence, ai_appearance,
      ai_personality, ai_activities, ai_relationships,
      ai_letter, read_model
    ) VALUES (
      ${p.age}, ${p.occupation}, ${p.residence}, ${p.appearance},
      ${p.personality}, ${p.activities}, ${p.relationships},
      ${letter}, ${model}
    )
    RETURNING id, edit_token`;

  return { id: String(rows[0].id), token: String(rows[0].edit_token) };
}

/** 2. 本人が確認・修正した内容を保存する。該当する行がなければ false */
export async function saveConfirmed({ id, token, profile, letter }) {
  await ensureTable();
  const p = pick(profile);
  const rows = await sql()`
    UPDATE letters SET
      age = ${p.age},
      occupation = ${p.occupation},
      residence = ${p.residence},
      appearance = ${p.appearance},
      personality = ${p.personality},
      activities = ${p.activities},
      relationships = ${p.relationships},
      letter = ${letter},
      confirmed_at = now()
    WHERE id = ${id} AND edit_token = ${token}
    RETURNING id`;

  return rows.length > 0;
}

/** 3. AIの返信を保存する */
export async function saveReply({ id, token, reply, model }) {
  await ensureTable();
  await sql()`
    UPDATE letters SET
      reply = ${reply},
      reply_model = ${model},
      replied_at = now()
    WHERE id = ${id} AND edit_token = ${token}`;
}

function pick(profile) {
  const out = {};
  for (const key of PROFILE_KEYS) out[key] = String(profile?.[key] ?? '');
  return out;
}
