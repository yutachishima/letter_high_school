/**
 * POST /api/read
 * 2枚の写真（1枚目：プロフィール、2枚目：手紙）をAIで読み取り、結果をデータベースに保存する。
 *
 * 受け取るもの: { profileImage: dataURL, letterImage: dataURL }
 * 返すもの    : { id, token, profile: {…7項目}, letter }
 *   読み取りには時間がかかるため、待っているあいだは10秒ごとに合図を送り、
 *   結果は最後にまとめて送ります（lib/common.js の startKeepAliveStream）。
 *
 * 写真はAIに渡すだけで、どこにも保存しません。
 */

import { readProfile, readLetter } from '../lib/ai.js';
import { assertDatabaseConfigured, ensureTable, insertReading } from '../lib/db.js';
import {
  AppError,
  allowPostOnly,
  checkImageDataUrl,
  errorBody,
  readBody,
  sendError,
  startKeepAliveStream
} from '../lib/common.js';

const FALLBACK_MESSAGE = '写真を読み取れませんでした。少し待ってから、もう一度お試しください。';

export default async function handler(req, res) {
  if (!allowPostOnly(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  let stream = null;
  try {
    const body = readBody(req);
    const profileImage = checkImageDataUrl(body.profileImage);
    const letterImage = checkImageDataUrl(body.letterImage);

    if (!profileImage || !letterImage) {
      throw new AppError('写真を2枚とも選んでください。（1枚目：プロフィール、2枚目：手紙）', 400);
    }

    // 保存先がない状態でAIを呼ばないように、先に確認する
    assertDatabaseConfigured();

    stream = startKeepAliveStream(res);

    const [, profileResult, letterResult] = await Promise.all([
      ensureTable(),
      readProfile(profileImage),
      readLetter(letterImage)
    ]);

    const { profile } = profileResult;
    const { letter } = letterResult;
    const model = profileResult.model === letterResult.model
      ? profileResult.model
      : `${profileResult.model} / ${letterResult.model}`;

    const { id, token } = await insertReading({ profile, letter, model });

    stream.send({ id, token, profile, letter });
  } catch (err) {
    if (stream) stream.send(errorBody(err, FALLBACK_MESSAGE));
    else sendError(res, err, FALLBACK_MESSAGE);
  }
}
