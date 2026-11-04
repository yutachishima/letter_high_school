/**
 * 共通の定義とヘルパー
 *  - プロフィールの項目（ワークシート「01」の項目と同じ並び）
 *  - 入力のチェック・整形
 *  - エラーの返し方
 */

/**
 * プロフィールの項目
 *   key   … データベースの列名（AIの読み取り結果は「ai_」を付けた列に入ります）
 *   label … ワークシートに印刷されている項目名
 *
 * 項目を変えるときは、public/index.html の PROFILE_FIELDS と、
 * lib/db.js のテーブル定義もあわせて変更してください。
 */
export const PROFILE_FIELDS = [
  { key: 'age', label: '年齢' },
  { key: 'occupation', label: '職業・身分' },
  { key: 'residence', label: '住んでいる場所や環境' },
  { key: 'appearance', label: '服装・髪型' },
  { key: 'personality', label: '性格' },
  { key: 'activities', label: '活動の様子（熱心に取り組んでいること）' },
  { key: 'relationships', label: '人間関係の様子（友達・家族・先輩後輩など）' }
];

export const PROFILE_KEYS = PROFILE_FIELDS.map(f => f.key);

export const MAX_FIELD_LENGTH = 1000;   // プロフィール1項目あたりの上限（文字）
export const MAX_LETTER_LENGTH = 6000;  // 手紙の上限（文字）
const MAX_IMAGE_CHARS = 2_200_000;      // 写真1枚あたりの上限（base64の文字数。約1.6MB）

/* ===================== エラー ===================== */

/** 画面にそのまま表示してよいメッセージを持つエラー */
export class AppError extends Error {
  constructor(message, status = 500, detail = '') {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** エラーを、画面に返す形（{ error, detail, status }）にする */
export function errorBody(err, fallbackMessage) {
  if (err instanceof AppError) {
    console.error(`[${err.status}] ${err.message}`, err.detail || '');
    return { error: err.message, detail: err.detail || undefined, status: err.status };
  }
  console.error(err);
  return {
    error: fallbackMessage,
    detail: String(err?.message || err || '').slice(0, 300) || undefined,
    status: 500
  };
}

export function sendError(res, err, fallbackMessage) {
  const body = errorBody(err, fallbackMessage);
  return res.status(body.status).json(body);
}

/* ===================== 時間のかかる処理の返し方 ===================== */

const KEEP_ALIVE_MS = 10_000;

/**
 * AIの処理には1分以上かかることがあります。そのあいだ何も送らないでいると、
 * iPhone の Safari や学校のネットワークが「応答がない」として通信を切ってしまうことがあるため、
 * 10秒ごとに「待っています」の合図を送り続け、最後に結果を「data: {…}」として1回だけ送ります。
 * （形式は Server-Sent Events。画面側の postJson がこの形を読み取ります）
 */
export function startKeepAliveStream(res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const ping = () => {
    try {
      res.write(': waiting\n\n');
    } catch {
      /* 画面が閉じられた場合など */
    }
  };
  ping();
  const timer = setInterval(ping, KEEP_ALIVE_MS);
  if (typeof res.on === 'function') res.on('close', () => clearInterval(timer));

  return {
    send(payload) {
      clearInterval(timer);
      res.end(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };
}

/** POST 以外は受け付けない */
export function allowPostOnly(req, res) {
  if (req.method === 'POST') return true;
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: 'Method not allowed' });
  return false;
}

/** req.body を取り出す（文字列で届いた場合にも対応） */
export function readBody(req) {
  const body = req.body;
  if (body && typeof body === 'object') return body;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return {};
}

/* ===================== 入力の整形 ===================== */

export function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, maxLength);
}

/** プロフィールを決まった項目だけの形にそろえる */
export function cleanProfile(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const key of PROFILE_KEYS) {
    out[key] = cleanText(src[key], MAX_FIELD_LENGTH);
  }
  return out;
}

/**
 * 便箋の行ごとの改行を取り除き、段落の区切り（空行）だけを残す
 * （AIが行ごとに改行してしまった場合の保険）
 */
export function normalizeLetterLineBreaks(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t　]*\n+/)
    .map(paragraph =>
      paragraph
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('')
    )
    .filter(Boolean)
    .join('\n\n');
}

/** 写真（dataURL）を確認する。問題があれば null */
export function checkImageDataUrl(value) {
  const s = String(value || '').trim();
  if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)) return null;
  if (s.length > MAX_IMAGE_CHARS) return null;
  return s;
}

/** データの番号（自動で振られる連番） */
export function checkId(value) {
  const s = String(value ?? '').trim();
  return /^\d{1,18}$/.test(s) ? s : null;
}

/** 本人確認用の合言葉（UUID） */
export function checkToken(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : null;
}
