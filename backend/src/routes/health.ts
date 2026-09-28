import { Router } from 'express';
import type { HealthResponse } from '@interview/shared';
import { checkFfmpeg } from '../lib/ffmpeg.js';
import { transcriberHealth } from '../lib/transcriber.js';

export const health = Router();

health.get('/health', async (_req, res) => {
  const ffmpeg = await checkFfmpeg();
  res.json({
    ok: true,
    ffmpeg,
    transcriber: transcriberHealth(),
  } satisfies HealthResponse);
});
