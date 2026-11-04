-- 保存されたデータを、日本語の列名で一覧にするSQLです。
-- Neon の「SQL Editor」に全部貼り付けて「Run」を押すと、結果が表に出ます。
-- 結果の右下にあるダウンロードのボタンから、CSV や XLSX（Excel）で保存できます。
--
-- 「AI読み取り」の列は、写真からAIが読み取った内容（本人が直す前）です。
-- 「修正あり／なし」は、本人がAIの読み取り結果を直したかどうかです。

SELECT
  id AS "ID",
  to_char(created_at   AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS') AS "読み取り日時",
  to_char(confirmed_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS') AS "確認日時",
  to_char(replied_at   AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS') AS "返信日時",
  CASE
    WHEN reply IS NOT NULL THEN '返信まで完了'
    WHEN confirmed_at IS NOT NULL THEN '確認まで（返信なし）'
    ELSE '読み取りのみ'
  END AS "状態",

  -- 本人が確認・修正したあとの内容
  age           AS "年齢",
  occupation    AS "職業・身分",
  residence     AS "住んでいる場所や環境",
  appearance    AS "服装・髪型",
  personality   AS "性格",
  activities    AS "活動の様子",
  relationships AS "人間関係の様子",
  letter        AS "手紙",

  -- AIの返信
  reply AS "AIの返信",

  -- 本人が直したかどうか
  CASE
    WHEN confirmed_at IS NULL THEN NULL
    WHEN (age, occupation, residence, appearance, personality, activities, relationships)
         IS DISTINCT FROM
         (ai_age, ai_occupation, ai_residence, ai_appearance, ai_personality, ai_activities, ai_relationships)
      THEN '修正あり'
    ELSE '修正なし'
  END AS "プロフィールの修正",
  CASE
    WHEN confirmed_at IS NULL THEN NULL
    WHEN letter IS DISTINCT FROM ai_letter THEN '修正あり'
    ELSE '修正なし'
  END AS "手紙の修正",

  -- AIが写真から読み取った内容（本人が直す前）
  ai_age           AS "年齢（AI読み取り）",
  ai_occupation    AS "職業・身分（AI読み取り）",
  ai_residence     AS "住んでいる場所や環境（AI読み取り）",
  ai_appearance    AS "服装・髪型（AI読み取り）",
  ai_personality   AS "性格（AI読み取り）",
  ai_activities    AS "活動の様子（AI読み取り）",
  ai_relationships AS "人間関係の様子（AI読み取り）",
  ai_letter        AS "手紙（AI読み取り）",

  read_model  AS "読み取りに使ったモデル",
  reply_model AS "返信に使ったモデル"
FROM letters
ORDER BY id;
