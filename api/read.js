/**
 * POST /api/read
 * 2枚の写真（1枚目：プロフィール、2枚目：手紙）をAIで読み取り、結果をデータベースに保存する。
 *
 * 受け取るもの: { profileImage: dataURL, letterImage: dataURL }
 * 返すもの    : { id, token, profile: {…7項目}, letter }
 *
 * 写真はAIに渡すだけで、どこにも保存しません。
 */

import { readProfile, readLetter, visionModel } from '../lib/ai.js';
import { assertDatabaseConfigured, ensureTable, insertReading } from '../lib/db.js';
import { AppError, allowPostOnly, checkImageDataUrl, readBody, sendError } from '../lib/common.js';

export default async function handler(req, res) {
  if (!allowPostOnly(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  try {
    const body = readBody(req);
    const profileImage = checkImageDataUrl(body.profileImage);
    const letterImage = checkImageDataUrl(body.letterImage);

    if (!profileImage || !letterImage) {
      throw new AppError('写真を2枚とも選んでください。（1枚目：プロフィール、2枚目：手紙）', 400);
    }

    // 保存先がない状態でAIを呼ばないように、先に確認する
    assertDatabaseConfigured();

    const [, profile, letter] = await Promise.all([
      ensureTable(),
      readProfile(profileImage),
      readLetter(letterImage)
    ]);

    const { id, token } = await insertReading({ profile, letter, model: visionModel() });

    return res.status(200).json({ id, token, profile, letter });
  } catch (err) {
    return sendError(res, err, '写真を読み取れませんでした。少し待ってから、もう一度お試しください。');
  }
}
