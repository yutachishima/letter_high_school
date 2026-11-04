/**
 * POST /api/reply
 * 本人が確認・修正した内容を保存し、「3年後の自分」からの返信をAIで書いて保存する。
 *
 * 受け取るもの: { id, token, profile: {…7項目}, letter }
 * 返すもの    : { reply }
 *   返信を書くのには時間がかかるため、待っているあいだは10秒ごとに合図を送り、
 *   結果は最後にまとめて送ります（lib/common.js の startKeepAliveStream）。
 */

import { writeReply } from '../lib/ai.js';
import { saveConfirmed, saveReply } from '../lib/db.js';
import {
  AppError,
  MAX_LETTER_LENGTH,
  allowPostOnly,
  checkId,
  checkToken,
  cleanProfile,
  cleanText,
  errorBody,
  readBody,
  sendError,
  startKeepAliveStream
} from '../lib/common.js';

const FALLBACK_MESSAGE = '返信を受け取れませんでした。少し待ってから、もう一度お試しください。';

export default async function handler(req, res) {
  if (!allowPostOnly(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  let stream = null;
  try {
    const body = readBody(req);
    const id = checkId(body.id);
    const token = checkToken(body.token);
    if (!id || !token) {
      throw new AppError('データが見つかりませんでした。お手数ですが、最初からやり直してください。', 400);
    }

    const profile = cleanProfile(body.profile);
    const letter = cleanText(body.letter, MAX_LETTER_LENGTH);
    if (!letter) {
      throw new AppError('手紙の内容が空です。手紙の欄に入力してください。', 400);
    }

    // 先に、確認・修正した内容を保存しておく（返信の作成に失敗しても残るように）
    const found = await saveConfirmed({ id, token, profile, letter });
    if (!found) {
      throw new AppError('データが見つかりませんでした。お手数ですが、最初からやり直してください。', 404);
    }

    stream = startKeepAliveStream(res);

    const { reply, model } = await writeReply(profile, letter);
    await saveReply({ id, token, reply, model });

    stream.send({ reply });
  } catch (err) {
    if (stream) stream.send(errorBody(err, FALLBACK_MESSAGE));
    else sendError(res, err, FALLBACK_MESSAGE);
  }
}
