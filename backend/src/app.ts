import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import multer from 'multer';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { requireAuth } from './lib/auth.js';
import { api } from './routes/api.js';
import { auth } from './routes/auth.js';
import { health } from './routes/health.js';
import { transcripts } from './routes/transcripts.js';

const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: '없는 경로입니다.', code: 'not_found' });
};

const onError: ErrorRequestHandler = (cause, _req, res, _next) => {
  if (cause instanceof HttpError) {
    res.status(cause.status).json({ error: cause.message, code: cause.code });
    return;
  }
  if (cause instanceof multer.MulterError) {
    const tooLarge = cause.code === 'LIMIT_FILE_SIZE';
    res.status(413).json({
      error: tooLarge
        ? `파일이 너무 큽니다. 한 파일당 ${Math.round(config.maxUploadBytes / 1024 ** 3)} GB까지 올릴 수 있습니다.`
        : '업로드에 실패했습니다. 파일 수와 크기를 확인해주세요.',
      code: cause.code,
    });
    return;
  }
  console.error('[api] 처리되지 않은 오류:', cause);
  res
    .status(500)
    .json({ error: '서버에서 오류가 발생했습니다.', code: 'internal_error' });
};

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // 개발 중에는 Vite(5273)에서 프록시로 호출한다. 쿠키를 주고받아야 하므로
  // 요청 오리진을 그대로 허용하고 credentials 를 켠다.
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // 로그인 전에도 닿아야 하는 경로.
  app.use('/api/auth', auth);
  app.use('/api', health);

  // 나머지 작업 API 는 모두 로그인 필요.
  // 받아쓰기 라우터를 먼저 붙인다 — /sessions/:id/transcripts 가
  // api 의 /sessions/:id 계열보다 구체적이기 때문.
  app.use('/api', requireAuth, transcripts);
  app.use('/api', requireAuth, api);

  app.use(notFound);
  app.use(onError);
  return app;
}
