import fs from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { Router } from 'express';
import multer from 'multer';
import type {
  RejectedUpload,
  UploadResponse,
} from '@interview/shared';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { checkFfmpeg } from '../lib/ffmpeg.js';
import {
  contentDisposition,
  decodeUploadFilename,
  isSupportedVideo,
} from '../lib/filenames.js';
import {
  addUploads,
  completedFiles,
  createSession,
  destroySession,
  getFile,
  removeFile,
  startExtraction,
  toState,
  touchSession,
  type PendingUpload,
} from '../lib/sessions.js';

const incomingDir = path.join(config.storageRoot, '_incoming');

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) => {
      void fs
        .mkdir(incomingDir, { recursive: true })
        .then(() => done(null, incomingDir))
        .catch((cause: Error) => done(cause, ''));
    },
    // 디스크에는 안전한 이름으로만 쓴다. 표시용 원본 이름은 메타데이터로 따로 보관한다.
    filename: (_req, _file, done) =>
      done(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
  }),
  limits: {
    fileSize: config.maxUploadBytes,
    files: config.maxFilesPerUpload,
  },
});

export const api = Router();

/**
 * 경로 파라미터를 문자열로 확정한다.
 * Express 5의 params 타입은 배열/undefined를 포함하므로 여기서 한 번 좁힌다.
 */
function param(req: { params: Record<string, unknown> }, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, '잘못된 요청 경로입니다.', 'bad_path_param');
  }
  return value;
}

api.post('/sessions', async (_req, res) => {
  const session = await createSession();
  res.status(201).json(toState(session));
});

api.get('/sessions/:sessionId', (req, res) => {
  res.json(toState(touchSession(param(req, 'sessionId'))));
});

api.post(
  '/sessions/:sessionId/files',
  upload.array('files'),
  async (req, res) => {
    const session = touchSession(param(req, 'sessionId'));
    const incoming = (req.files as Express.Multer.File[] | undefined) ?? [];

    const accepted: PendingUpload[] = [];
    const rejected: RejectedUpload[] = [];

    for (const file of incoming) {
      const originalName = decodeUploadFilename(file.originalname);
      if (!isSupportedVideo(originalName)) {
        await fs.rm(file.path, { force: true });
        rejected.push({
          originalName,
          code: 'unsupported_format',
          reason: '지원하지 않는 형식입니다.',
        });
        continue;
      }
      accepted.push({
        originalName,
        tempPath: file.path,
        sizeBytes: file.size,
      });
    }

    await addUploads(session, accepted);
    const body: UploadResponse = { session: toState(session), rejected };
    res.status(201).json(body);
  },
);

api.delete('/sessions/:sessionId/files/:fileId', async (req, res) => {
  const session = touchSession(param(req, 'sessionId'));
  await removeFile(session, param(req, 'fileId'));
  res.json(toState(session));
});

api.post('/sessions/:sessionId/extract', async (req, res) => {
  const session = touchSession(param(req, 'sessionId'));
  const ffmpeg = await checkFfmpeg();
  if (!ffmpeg.available) {
    throw new HttpError(
      503,
      'ffmpeg가 설치되어 있지 않아 변환을 시작할 수 없습니다.',
      'ffmpeg_unavailable',
    );
  }
  startExtraction(session);
  res.status(202).json(toState(session));
});

api.get('/sessions/:sessionId/files/:fileId/audio', (req, res) => {
  const session = touchSession(param(req, 'sessionId'));
  const file = getFile(session, param(req, 'fileId'));
  if (!file.outputPath) {
    throw new HttpError(
      409,
      '아직 추출된 음성이 없습니다.',
      'output_not_ready',
    );
  }
  const asDownload = req.query.download === '1';
  res.setHeader('Content-Type', 'audio/mp4');
  res.setHeader(
    'Content-Disposition',
    contentDisposition(file.outputName, !asDownload),
  );
  // dotfiles: 'allow' — STORAGE_ROOT 경로에 .cache 같은 숨김 폴더가 있어도 404가 되지 않게.
  // send의 기본값은 점으로 시작하는 경로 세그먼트를 거부한다.
  res.sendFile(file.outputPath, { dotfiles: 'allow' });
});

api.get('/sessions/:sessionId/archive', (req, res) => {
  const session = touchSession(param(req, 'sessionId'));
  const files = completedFiles(session);
  if (files.length === 0) {
    throw new HttpError(
      409,
      '다운로드할 음성 파일이 없습니다.',
      'nothing_to_archive',
    );
  }

  const state = toState(session);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    contentDisposition(state.archiveName, false),
  );

  const archive = archiver('zip', { zlib: { level: 0 } });
  archive.on('warning', (cause) => console.warn('[archive]', cause));
  archive.on('error', (cause) => {
    console.error('[archive]', cause);
    res.destroy(cause);
  });
  archive.pipe(res);

  // 같은 이름이 둘 이상이면 뒤에 번호를 붙여 ZIP 안에서 덮어쓰지 않게 한다.
  const used = new Map<string, number>();
  for (const file of files) {
    const seen = used.get(file.outputName) ?? 0;
    used.set(file.outputName, seen + 1);
    const ext = path.extname(file.outputName);
    const entryName =
      seen === 0
        ? file.outputName
        : `${file.outputName.slice(0, -ext.length)} (${seen + 1})${ext}`;
    archive.file(file.outputPath as string, { name: entryName });
  }
  void archive.finalize();
});

api.delete('/sessions/:sessionId', async (req, res) => {
  await destroySession(param(req, 'sessionId'));
  res.status(204).end();
});
