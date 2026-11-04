/**
 * OpenAI（Responses API）の呼び出し
 *   readProfile … 1枚目の写真からプロフィールを読み取る
 *   readLetter  … 2枚目の写真から手紙を読み取る
 *   writeReply  … 3年後の自分からの返信を書く
 *
 * モデルと推論の深さは、環境変数で変えられます（書かなければ下の既定値）。
 *   OPENAI_VISION_MODEL … 写真の読み取りに使うモデル（既定: gpt-6.1-sol）
 *   OPENAI_TEXT_MODEL   … 返信を書くのに使うモデル（既定: gpt-6.1-sol）
 *   OPENAI_READ_EFFORT  … 読み取りの推論の深さ（既定: high）
 *   OPENAI_REPLY_EFFORT … 返信の推論の深さ（既定: high）
 *     推論の深さは low < medium < high < xhigh < max。深いほど丁寧ですが、時間がかかります。
 *
 * 指定したモデルがこのAPIキーで使えない場合は、自動で gpt-5.6 に切り替えます。
 * 実際に使ったモデル名は、データベースの read_model / reply_model に保存されます。
 */

import {
  AppError,
  PROFILE_FIELDS,
  PROFILE_KEYS,
  MAX_LETTER_LENGTH,
  cleanProfile,
  cleanText,
  normalizeLetterLineBreaks
} from './common.js';
import {
  PROFILE_READ_PROMPT,
  LETTER_READ_PROMPT,
  REPLY_INSTRUCTIONS,
  buildReplyInput
} from './prompts.js';

const DEFAULT_MODEL = 'gpt-6.1-sol';
const FALLBACK_MODEL = 'gpt-5.6';
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const visionModel = () => process.env.OPENAI_VISION_MODEL || DEFAULT_MODEL;
export const textModel = () => process.env.OPENAI_TEXT_MODEL || DEFAULT_MODEL;
const readEffort = () => pickEffort(process.env.OPENAI_READ_EFFORT, 'high');
const replyEffort = () => pickEffort(process.env.OPENAI_REPLY_EFFORT, 'high');

function pickEffort(value, fallback) {
  const v = String(value || '').trim().toLowerCase();
  return EFFORTS.includes(v) ? v : fallback;
}

// 1回の呼び出しで待つ時間の上限（vercel.json の maxDuration = 300秒 より短くしておく）
const READ_TIMEOUT_MS = 270_000;
const REPLY_TIMEOUT_MS = 260_000;

const RETAKE_MESSAGE =
  '書いた部分が画面いっぱいに写るように、明るい場所で、影が入らないように撮り直してみてください。';

/* ===================== 1枚目：プロフィール ===================== */

/** @returns {Promise<{ profile: object, model: string }>} */
export async function readProfile(imageDataUrl) {
  const schema = {
    type: 'object',
    properties: Object.fromEntries(
      PROFILE_FIELDS.map(f => [
        f.key,
        { type: 'string', description: `「●${f.label}：」の欄に手書きで書かれた内容。空欄なら空の文字列。` }
      ])
    ),
    required: PROFILE_KEYS,
    additionalProperties: false
  };

  const result = await callResponses(
    {
      model: visionModel(),
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: PROFILE_READ_PROMPT },
            { type: 'input_image', image_url: imageDataUrl, detail: 'original' }
          ]
        }
      ],
      text: {
        verbosity: 'high',
        format: { type: 'json_schema', name: 'profile', strict: true, schema }
      },
      reasoning: { effort: readEffort() },
      max_output_tokens: 25000
    },
    { timeoutMs: READ_TIMEOUT_MS }
  );

  const data = result.refusal ? null : parseJsonObject(result.text);
  if (!data) {
    throw new AppError(`1枚目の写真（プロフィール）を読み取れませんでした。${RETAKE_MESSAGE}`, 422, result.refusal);
  }
  return { profile: cleanProfile(data), model: result.model };
}

/* ===================== 2枚目：手紙 ===================== */

/** @returns {Promise<{ letter: string, model: string }>} */
export async function readLetter(imageDataUrl) {
  const schema = {
    type: 'object',
    properties: {
      letter: { type: 'string', description: '手書きの手紙の本文。段落の区切りだけ空行を入れる。' }
    },
    required: ['letter'],
    additionalProperties: false
  };

  const result = await callResponses(
    {
      model: visionModel(),
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: LETTER_READ_PROMPT },
            { type: 'input_image', image_url: imageDataUrl, detail: 'original' }
          ]
        }
      ],
      text: {
        verbosity: 'high',
        format: { type: 'json_schema', name: 'letter', strict: true, schema }
      },
      reasoning: { effort: readEffort() },
      max_output_tokens: 25000
    },
    { timeoutMs: READ_TIMEOUT_MS }
  );

  const data = result.refusal ? null : parseJsonObject(result.text);
  if (!data || typeof data.letter !== 'string') {
    throw new AppError(`2枚目の写真（手紙）を読み取れませんでした。${RETAKE_MESSAGE}`, 422, result.refusal);
  }
  return {
    letter: normalizeLetterLineBreaks(cleanText(data.letter, MAX_LETTER_LENGTH)),
    model: result.model
  };
}

/* ===================== 3年後の自分からの返信 ===================== */

/** @returns {Promise<{ reply: string, model: string }>} */
export async function writeReply(profile, letter) {
  const result = await callResponses(
    {
      model: textModel(),
      instructions: REPLY_INSTRUCTIONS,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: buildReplyInput(profile, letter) }]
        }
      ],
      reasoning: { effort: replyEffort() },
      max_output_tokens: 20000
    },
    { timeoutMs: REPLY_TIMEOUT_MS }
  );

  if (result.refusal || !result.text) {
    throw new AppError('返信を書けませんでした。手紙の内容を確認して、もう一度お試しください。', 502, result.refusal);
  }
  return { reply: result.text.trim(), model: result.model };
}

/* ===================== Responses API ===================== */

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

async function callResponses(body, { timeoutMs }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new AppError('OpenAIのAPIキーが設定されていません（環境変数 OPENAI_API_KEY）。', 500);
  }

  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const deadline = Date.now() + timeoutMs;

  // 使うモデルの順番（指定したモデルが使えなければ、予備のモデル）
  const models = [body.model, FALLBACK_MODEL].filter((m, i, list) => m && list.indexOf(m) === i);
  let modelIndex = 0;
  let payload = { ...body, model: models[0], store: false };
  let retries = 0;
  let fallbacks = 0;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining < 1000) throw timeoutError();

    let status;
    let headers;
    let raw;
    try {
      const response = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(remaining)
      });
      status = response.status;
      headers = response.headers;
      raw = await response.text();
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw timeoutError();
      if (retries < MAX_RETRIES) {
        retries++;
        await sleep(1000 * retries);
        continue;
      }
      throw new AppError(
        'AIに接続できませんでした。少し待ってから、もう一度お試しください。',
        502,
        String(err?.message || err)
      );
    }

    const data = safeJsonParse(raw);

    if (status >= 200 && status < 300) {
      if (data?.status === 'incomplete') {
        throw new AppError(
          'AIの応答が途中で終わってしまいました。もう一度お試しください。',
          502,
          JSON.stringify(data?.incomplete_details || {})
        );
      }
      return { ...extractOutput(data), model: String(data?.model || payload.model) };
    }

    const message = String(data?.error?.message || raw || `HTTP ${status}`).slice(0, 500);
    const code = String(data?.error?.code || '');
    const param = String(data?.error?.param || '');

    // 指定したモデルが対応していない設定があれば、その設定を外してやり直す
    if (status === 400 && fallbacks < 3) {
      const next = dropUnsupportedOption(payload, `${message} ${param}`);
      if (next) {
        payload = next;
        fallbacks++;
        continue;
      }
    }

    // 指定したモデルがこのAPIキーで使えなければ、予備のモデルに切り替える
    if (isModelUnavailable(status, code, message) && modelIndex < models.length - 1) {
      modelIndex++;
      console.warn(`[model fallback] ${payload.model} → ${models[modelIndex]} (${status} ${code}: ${message})`);
      payload = { ...body, model: models[modelIndex], store: false };
      fallbacks = 0;
      continue;
    }

    // 混み合っているなど、一時的なエラーは少し待ってやり直す
    if (RETRY_STATUS.has(status) && code !== 'insufficient_quota' && retries < MAX_RETRIES) {
      const wait = Math.min(retryAfterMs(headers) ?? 2000 * (retries + 1), 10_000);
      if (Date.now() + wait < deadline - 5000) {
        retries++;
        await sleep(wait);
        continue;
      }
    }

    throw openAIError(status, code, message);
  }
}

/** モデルそのものが使えないエラーかどうか */
function isModelUnavailable(status, code, message) {
  if (code === 'model_not_found' || status === 404) return true;
  if (status === 403 && /model/i.test(message)) return true;
  if (status === 400 && /model/i.test(message) && /does not exist|do not have access|not have access|invalid model/i.test(message)) return true;
  return false;
}

/** モデルが対応していない設定（reasoning / verbosity / 画像の detail）を外す */
function dropUnsupportedOption(payload, errorText) {
  const p = structuredClone(payload);

  if (/reasoning/i.test(errorText) && p.reasoning) {
    delete p.reasoning;
    return p;
  }
  if (/verbosity/i.test(errorText) && p.text?.verbosity) {
    delete p.text.verbosity;
    return p;
  }
  if (/detail|original/i.test(errorText)) {
    let changed = false;
    for (const msg of p.input || []) {
      for (const part of Array.isArray(msg?.content) ? msg.content : []) {
        if (part?.type === 'input_image' && part.detail && part.detail !== 'auto') {
          part.detail = 'auto';
          changed = true;
        }
      }
    }
    if (changed) return p;
  }
  return null;
}

/** Responses API の結果から、本文と「お断り」の有無を取り出す */
function extractOutput(data) {
  const texts = [];
  let refusal = '';

  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
      else if (part?.type === 'refusal') refusal = String(part.refusal || 'refusal');
    }
  }

  let text = texts.join('\n').trim();
  if (!text && typeof data?.output_text === 'string') text = data.output_text.trim();
  return { text, refusal };
}

function openAIError(status, code, message) {
  if (status === 401) {
    return new AppError('OpenAIのAPIキーが正しくないようです（環境変数 OPENAI_API_KEY を確認してください）。', 500, message);
  }
  if (code === 'insufficient_quota') {
    return new AppError('OpenAIの利用枠（クレジット）が不足しています。OpenAIの管理画面で支払い設定を確認してください。', 500, message);
  }
  if (status === 404 || code === 'model_not_found') {
    return new AppError('指定したAIのモデルが見つかりません（環境変数 OPENAI_VISION_MODEL / OPENAI_TEXT_MODEL を確認してください）。', 500, message);
  }
  if (status === 403) {
    return new AppError('このAPIキーでは、指定したAIのモデルを使えないようです。', 500, message);
  }
  if (status === 429 || status >= 500) {
    return new AppError('AIが混み合っています。少し待ってから、もう一度お試しください。', 503, message);
  }
  return new AppError('AIとのやりとりでエラーが起きました。もう一度お試しください。', 502, message);
}

function timeoutError() {
  return new AppError('AIの応答に時間がかかりすぎています。少し待ってから、もう一度お試しください。', 504);
}

function retryAfterMs(headers) {
  const v = headers?.get?.('retry-after');
  if (!v) return null;
  const seconds = Number(v);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function parseJsonObject(text) {
  const s = String(text || '').trim();
  const direct = safeJsonParse(s);
  if (direct && typeof direct === 'object') return direct;
  const m = s.match(/\{[\s\S]*\}/);
  const inner = m ? safeJsonParse(m[0]) : null;
  return inner && typeof inner === 'object' ? inner : null;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
