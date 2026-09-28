import fs from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { Router } from 'express';
import multer from 'multer';
import type {
  RejectedUpload,
  TranscriptUploadResponse,
} from '@interview/shared';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import {
  contentDisposition,
  decodeUploadFilename,
  isSupportedAudio,
} from '../lib/filenames.js';
import {
  addTranscriptUploads,
  adoptExtractedAudio,
  combinedPathOf,
  completedTranscripts,
  getTranscript,
  refreshCombined,
  removeTranscript,
  setCombineEnabled,
  startTranscription,
  toTranscriptState,
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
    filename: (_req, _file, done) =>
      done(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
  }),
  limits: {
    fileSize: config.maxUploadBytes,
    files: config.maxFilesPerUpload,
  },
});

export const transcripts = Router();

function param(
  req: { params: Record<string, unknown> },
  name: string,
): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, '잘못된 요청 경로입니다.', 'bad_path_param');
  }
  return value;
}

transcripts.get('/sessions/:sessionId/transcripts', (req, res) => {
  res.json(toTranscriptState(touchSession(param(req, 'sessionId'))));
});

transcripts.post(
  '/sessions/:sessionId/transcripts/files',
  upload.array('files'),
  async (req, res) => {
    const session = touchSession(param(req, 'sessionId'));
    const incoming = (req.files as Express.Multer.File[] | undefined) ?? [];

    const accepted: PendingUpload[] = [];
    const rejected: RejectedUpload[] = [];

    for (const file of incoming) {
      const originalName = decodeUploadFilename(file.originalname);
      if (!isSupportedAudio(originalName)) {
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

    await addTranscriptUploads(session, accepted);
    const body: TranscriptUploadResponse = {
      session: toTranscriptState(session),
      rejected,
    };
    res.status(201).json(body);
  },
);

/**
 * 음성 추출 결과를 받아쓰기 목록으로 가져온다 (복사 없이 경로만 참조).
 * 영상 → 음성 → 텍스트를 한 흐름으로 잇기 위한 연결점.
 */
transcripts.post(
  '/sessions/:sessionId/transcripts/adopt',
  async (req, res) => {
    const session = touchSession(param(req, 'sessionId'));
    const added = await adoptExtractedAudio(session);
    if (added.length === 0) {
      throw new HttpError(
        409,
        '가져올 음성 추출 결과가 없습니다.',
        'nothing_to_adopt',
      );
    }
    res.status(201).json(toTranscriptState(session));
  },
);

transcripts.delete(
  '/sessions/:sessionId/transcripts/files/:fileId',
  async (req, res) => {
    const session = touchSession(param(req, 'sessionId'));
    await removeTranscript(session, param(req, 'fileId'));
    res.json(toTranscriptState(session));
  },
);

transcripts.post(
  '/sessions/:sessionId/transcripts/combine',
  async (req, res) => {
    const session = touchSession(param(req, 'sessionId'));
    const body = req.body as { enabled?: unknown } | undefined;
    setCombineEnabled(session, body?.enabled !== false);
    await refreshCombined(session);
    res.json(toTranscriptState(session));
  },
);

transcripts.post(
  '/sessions/:sessionId/transcripts/start',
  (req, res) => {
    const session = touchSession(param(req, 'sessionId'));
    startTranscription(session);
    res.status(202).json(toTranscriptState(session));
  },
);

transcripts.get(
  '/sessions/:sessionId/transcripts/files/:fileId/text',
  (req, res) => {
    const session = touchSession(param(req, 'sessionId'));
    const item = getTranscript(session, param(req, 'fileId'));
    if (!item.transcriptPath) {
      throw new HttpError(
        409,
        '아직 받아쓰기 결과가 없습니다.',
        'transcript_not_ready',
      );
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(item.outputName, req.query.download !== '1'),
    );
    res.sendFile(item.transcriptPath, { dotfiles: 'allow' });
  },
);

transcripts.get('/sessions/:sessionId/transcripts/combined', (req, res) => {
  const session = touchSession(param(req, 'sessionId'));
  const combined = combinedPathOf(session);
  const state = toTranscriptState(session);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    contentDisposition(state.combined.fileName, req.query.download !== '1'),
  );
  res.sendFile(combined, { dotfiles: 'allow' });
});

transcripts.get('/sessions/:sessionId/transcripts/archive', (req, res) => {
  const session = touchSession(param(req, 'sessionId'));
  const items = completedTranscripts(session);
  if (items.length === 0) {
    throw new HttpError(
      409,
      '다운로드할 받아쓰기 결과가 없습니다.',
      'nothing_to_archive',
    );
  }

  const state = toTranscriptState(session);
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

  const used = new Map<string, number>();
  for (const item of items) {
    const seen = used.get(item.outputName) ?? 0;
    used.set(item.outputName, seen + 1);
    const ext = path.extname(item.outputName);
    const entryName =
      seen === 0
        ? item.outputName
        : `${item.outputName.slice(0, -ext.length)} (${seen + 1})${ext}`;
    archive.file(item.transcriptPath as string, { name: entryName });
  }
  // 통합 파일을 만들었다면 ZIP 에도 함께 담는다.
  if (session.combineEnabled && state.combined.available) {
    archive.file(combinedPathOf(session), { name: state.combined.fileName });
  }
  void archive.finalize();
});
