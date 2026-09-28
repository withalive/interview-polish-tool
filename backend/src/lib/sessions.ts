import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AUDIO_OUTPUT_EXTENSION,
  TRANSCRIPT_OUTPUT_EXTENSION,
  type ExtractErrorCode,
  type MediaFile,
  type SessionCounts,
  type SessionState,
  type TranscriptErrorCode,
  type TranscriptFile,
  type TranscriptSessionState,
} from '@interview/shared';
import { config } from '../config.js';
import { ExtractError, HttpError } from './errors.js';
import { extractAudio, probe } from './ffmpeg.js';
import {
  archiveNameFor,
  combinedTranscriptName,
  extensionOf,
  toAudioName,
  toTranscriptName,
  transcriptArchiveNameFor,
} from './filenames.js';
import { transcribe } from './transcriber.js';

interface StoredFile extends MediaFile {
  /** 디스크에 저장된 원본 영상 경로. 변환 후 삭제되면 null. */
  sourcePath: string | null;
  /** 추출 결과 경로. 아직 없으면 null. */
  outputPath: string | null;
}

/** 받아쓰기 대상 한 건. 음성 파일은 복사하지 않고 경로로만 가리킨다. */
export interface StoredTranscript extends TranscriptFile {
  /** 받아쓸 음성 파일 경로. 직접 업로드분이거나 음성 추출 결과를 그대로 가리킨다. */
  audioPath: string;
  /** 생성된 txt 경로. 아직 없으면 null. */
  transcriptPath: string | null;
  /** 이 세션이 소유한 파일인지. false 면(추출 결과 재사용) 삭제해도 원본을 지우지 않는다. */
  ownsAudio: boolean;
}

interface Session {
  sessionId: string;
  dir: string;
  uploadsDir: string;
  outputsDir: string;
  audioDir: string;
  transcriptsDir: string;
  files: Map<string, StoredFile>;
  order: string[];
  running: boolean;
  /** 받아쓰기 영역 — 음성 추출과 독립적으로 돌아간다. */
  transcripts: Map<string, StoredTranscript>;
  transcriptOrder: string[];
  transcribing: boolean;
  combineEnabled: boolean;
  combinedPath: string | null;
  /** 통합 파일의 글자 수. 주제 나누기 탭에서 보여준다. */
  combinedCharCount: number;
  lastAccessAt: number;
}

const sessions = new Map<string, Session>();

const uploadsDirOf = (dir: string) => path.join(dir, 'uploads');
const outputsDirOf = (dir: string) => path.join(dir, 'outputs');
const audioDirOf = (dir: string) => path.join(dir, 'audio');
const transcriptsDirOf = (dir: string) => path.join(dir, 'transcripts');

export async function createSession(): Promise<Session> {
  const sessionId = randomUUID();
  const dir = path.join(config.storageRoot, sessionId);
  const session: Session = {
    sessionId,
    dir,
    uploadsDir: uploadsDirOf(dir),
    outputsDir: outputsDirOf(dir),
    audioDir: audioDirOf(dir),
    transcriptsDir: transcriptsDirOf(dir),
    files: new Map(),
    order: [],
    running: false,
    transcripts: new Map(),
    transcriptOrder: [],
    transcribing: false,
    combineEnabled: false,
    combinedPath: null,
    combinedCharCount: 0,
    lastAccessAt: Date.now(),
  };
  await fs.mkdir(session.uploadsDir, { recursive: true });
  await fs.mkdir(session.outputsDir, { recursive: true });
  await fs.mkdir(session.audioDir, { recursive: true });
  await fs.mkdir(session.transcriptsDir, { recursive: true });
  sessions.set(sessionId, session);
  return session;
}

/** 세션을 찾고 마지막 접근 시각을 갱신한다 (청소 대상에서 밀려난다). */
export function touchSession(sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new HttpError(
      404,
      '세션을 찾을 수 없습니다. 페이지를 새로고침한 뒤 다시 업로드해주세요.',
      'session_not_found',
    );
  }
  session.lastAccessAt = Date.now();
  return session;
}

export function getFile(session: Session, fileId: string): StoredFile {
  const file = session.files.get(fileId);
  if (!file) {
    throw new HttpError(404, '파일을 찾을 수 없습니다.', 'file_not_found');
  }
  return file;
}

export interface PendingUpload {
  originalName: string;
  /** multer가 저장한 임시 경로. */
  tempPath: string;
  sizeBytes: number;
}

/** 업로드된 파일을 세션에 등록한다. 이름 기준으로 정렬해 순서를 안정화한다. */
export async function addUploads(
  session: Session,
  uploads: PendingUpload[],
): Promise<StoredFile[]> {
  const sorted = [...uploads].sort((a, b) =>
    a.originalName.localeCompare(b.originalName, 'ko', { numeric: true }),
  );

  const added: StoredFile[] = [];
  for (const upload of sorted) {
    const fileId = randomUUID();
    const ext = extensionOf(upload.originalName);
    const sourcePath = path.join(session.uploadsDir, `${fileId}${ext}`);
    await fs.rename(upload.tempPath, sourcePath);

    const file: StoredFile = {
      fileId,
      originalName: upload.originalName,
      outputName: toAudioName(upload.originalName),
      sizeBytes: upload.sizeBytes,
      status: 'queued',
      progress: 0,
      durationSeconds: null,
      outputSizeBytes: null,
      error: null,
      errorCode: null,
      sourcePath,
      outputPath: null,
    };
    session.files.set(fileId, file);
    session.order.push(fileId);
    added.push(file);
  }
  return added;
}

export async function removeFile(
  session: Session,
  fileId: string,
): Promise<void> {
  const file = getFile(session, fileId);
  if (file.status === 'processing') {
    throw new HttpError(
      409,
      '변환 중인 파일은 삭제할 수 없습니다.',
      'file_busy',
    );
  }
  await Promise.all([
    file.sourcePath ? fs.rm(file.sourcePath, { force: true }) : null,
    file.outputPath ? fs.rm(file.outputPath, { force: true }) : null,
  ]);
  session.files.delete(fileId);
  session.order = session.order.filter((id) => id !== fileId);
}

function orderedFiles(session: Session): StoredFile[] {
  return session.order
    .map((id) => session.files.get(id))
    .filter((file): file is StoredFile => Boolean(file));
}

function countsOf(files: StoredFile[]): SessionCounts {
  return {
    total: files.length,
    queued: files.filter((f) => f.status === 'queued').length,
    processing: files.filter((f) => f.status === 'processing').length,
    done: files.filter((f) => f.status === 'done').length,
    failed: files.filter((f) => f.status === 'failed').length,
  };
}

export function toState(session: Session): SessionState {
  const files = orderedFiles(session);
  return {
    sessionId: session.sessionId,
    running: session.running,
    counts: countsOf(files),
    archiveName: archiveNameFor(files.map((file) => file.originalName)),
    // 내부 경로는 클라이언트로 보내지 않는다.
    files: files.map(({ sourcePath: _s, outputPath: _o, ...rest }) => rest),
  };
}

export function completedFiles(session: Session): StoredFile[] {
  return orderedFiles(session).filter(
    (file) => file.status === 'done' && file.outputPath,
  );
}

async function convertOne(session: Session, file: StoredFile): Promise<void> {
  file.status = 'processing';
  file.progress = 0;
  file.error = null;
  file.errorCode = null;

  try {
    if (!file.sourcePath) {
      throw new ExtractError(
        'source_missing',
        '원본 영상이 서버에 없습니다. 다시 업로드해주세요.',
      );
    }

    const { hasAudio, durationSeconds } = await probe(file.sourcePath);
    file.durationSeconds = durationSeconds;

    if (!hasAudio) {
      throw new ExtractError(
        'no_audio_stream',
        '이 영상에는 음성 트랙이 없습니다.',
      );
    }

    const outputPath = path.join(
      session.outputsDir,
      `${file.fileId}${AUDIO_OUTPUT_EXTENSION}`,
    );
    await extractAudio({
      input: file.sourcePath,
      output: outputPath,
      durationSeconds,
      onProgress: (percent) => {
        // 실패 후 늦게 도착한 콜백이 상태를 되돌리지 않게 한다.
        if (file.status === 'processing') file.progress = percent;
      },
    });

    const stat = await fs.stat(outputPath);
    file.outputPath = outputPath;
    file.outputSizeBytes = stat.size;
    file.progress = 100;
    file.status = 'done';

    if (config.deleteSourceAfterExtract && file.sourcePath) {
      await fs.rm(file.sourcePath, { force: true });
      file.sourcePath = null;
    }
  } catch (cause) {
    file.status = 'failed';
    file.progress = 0;
    if (cause instanceof ExtractError) {
      file.error = cause.message;
      // 음성 추출 경로에서는 추출 계열 코드만 나온다. 아니면 일반 실패로 본다.
      const extractCodes: ExtractErrorCode[] = [
        'unsupported_format',
        'probe_failed',
        'no_audio_stream',
        'ffmpeg_failed',
        'source_missing',
        'ffmpeg_unavailable',
      ];
      file.errorCode = extractCodes.includes(cause.code as ExtractErrorCode)
        ? (cause.code as ExtractErrorCode)
        : 'ffmpeg_failed';
      if (cause.detail) {
        console.error(`[extract] ${file.originalName}: ${cause.detail}`);
      }
    } else {
      file.error = '알 수 없는 오류로 변환에 실패했습니다.';
      file.errorCode = 'ffmpeg_failed';
      console.error(`[extract] ${file.originalName}:`, cause);
    }
  }
}

/**
 * 대기 중인 파일을 변환한다. 한 파일이 실패해도 나머지는 계속 진행한다.
 * 이미 돌고 있으면 아무것도 하지 않는다.
 */
export function startExtraction(session: Session): void {
  if (session.running) return;
  const queued = orderedFiles(session).filter(
    (file) => file.status === 'queued',
  );
  if (queued.length === 0) return;

  session.running = true;
  const queue = [...queued];
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      session.lastAccessAt = Date.now();
      await convertOne(session, next);
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(config.concurrency, queue.length)) },
    () => worker(),
  );

  void Promise.all(workers)
    .catch((cause) => console.error('[extract] 작업자 오류:', cause))
    .finally(() => {
      session.running = false;
      session.lastAccessAt = Date.now();
    });
}

export async function destroySession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.running || session.transcribing) {
    throw new HttpError(
      409,
      '변환이 진행 중입니다. 끝난 뒤 다시 시도해주세요.',
      'session_busy',
    );
  }
  sessions.delete(sessionId);
  await fs.rm(session.dir, { recursive: true, force: true });
}

/**
 * 마지막 접근이 TTL을 넘긴 세션을 지운다.
 * 변환 중인 세션은 건너뛴다. 다운로드도 접근으로 집계되므로
 * 사용자가 결과를 받기 전에 사라지지 않는다.
 */
export async function sweepSessions(now = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  for (const [sessionId, session] of [...sessions]) {
    if (session.running || session.transcribing) continue;
    if (now - session.lastAccessAt < config.sessionTtlMs) continue;
    sessions.delete(sessionId);
    await fs.rm(session.dir, { recursive: true, force: true });
    removed.push(sessionId);
  }
  return removed;
}

/** 서버 시작 시 이전 실행이 남긴 폴더를 모두 비운다. */
export async function purgeStorageRoot(): Promise<void> {
  await fs.rm(config.storageRoot, { recursive: true, force: true });
  await fs.mkdir(config.storageRoot, { recursive: true });
}

/** 테스트용 — 메모리 상태만 초기화한다. */
export function resetSessionsForTest(): void {
  sessions.clear();
}

// ── 텍스트 추출 (받아쓰기) ──────────────────────────────────────────────

function orderedTranscripts(session: Session): StoredTranscript[] {
  return session.transcriptOrder
    .map((id) => session.transcripts.get(id))
    .filter((item): item is StoredTranscript => Boolean(item));
}

function transcriptCounts(items: StoredTranscript[]): SessionCounts {
  return {
    total: items.length,
    queued: items.filter((f) => f.status === 'queued').length,
    processing: items.filter((f) => f.status === 'processing').length,
    done: items.filter((f) => f.status === 'done').length,
    failed: items.filter((f) => f.status === 'failed').length,
  };
}

export function toTranscriptState(session: Session): TranscriptSessionState {
  const items = orderedTranscripts(session);
  const names = items.map((item) => item.originalName);
  return {
    sessionId: session.sessionId,
    running: session.transcribing,
    counts: transcriptCounts(items),
    archiveName: transcriptArchiveNameFor(names),
    combineEnabled: session.combineEnabled,
    combined: {
      fileName: combinedTranscriptName(names),
      available: Boolean(session.combinedPath),
      charCount: session.combinedCharCount,
    },
    // 내부 경로는 클라이언트로 내보내지 않는다.
    files: items.map(
      ({ audioPath: _a, transcriptPath: _t, ownsAudio: _o, ...rest }) => rest,
    ),
  };
}

export function getTranscript(
  session: Session,
  fileId: string,
): StoredTranscript {
  const item = session.transcripts.get(fileId);
  if (!item) {
    throw new HttpError(404, '파일을 찾을 수 없습니다.', 'file_not_found');
  }
  return item;
}

function registerTranscript(
  session: Session,
  input: {
    originalName: string;
    audioPath: string;
    sizeBytes: number;
    ownsAudio: boolean;
    sourceLabel: string | null;
  },
): StoredTranscript {
  const fileId = randomUUID();
  const item: StoredTranscript = {
    fileId,
    originalName: input.originalName,
    outputName: toTranscriptName(input.originalName),
    sizeBytes: input.sizeBytes,
    status: 'queued',
    progress: 0,
    durationSeconds: null,
    segmentCount: null,
    text: null,
    error: null,
    errorCode: null,
    sourceLabel: input.sourceLabel,
    audioPath: input.audioPath,
    transcriptPath: null,
    ownsAudio: input.ownsAudio,
  };
  session.transcripts.set(fileId, item);
  session.transcriptOrder.push(fileId);
  return item;
}

/** 직접 업로드한 음성 파일을 받아쓰기 대상으로 등록한다. */
export async function addTranscriptUploads(
  session: Session,
  uploads: PendingUpload[],
): Promise<StoredTranscript[]> {
  const sorted = [...uploads].sort((a, b) =>
    a.originalName.localeCompare(b.originalName, 'ko', { numeric: true }),
  );

  const added: StoredTranscript[] = [];
  for (const upload of sorted) {
    const ext = extensionOf(upload.originalName);
    const audioPath = path.join(session.audioDir, `${randomUUID()}${ext}`);
    await fs.rename(upload.tempPath, audioPath);
    added.push(
      registerTranscript(session, {
        originalName: upload.originalName,
        audioPath,
        sizeBytes: upload.sizeBytes,
        ownsAudio: true,
        sourceLabel: null,
      }),
    );
  }
  return added;
}

/**
 * 음성 추출 단계에서 만들어진 m4a 를 받아쓰기 대상으로 가져온다.
 * 파일을 복사하지 않고 같은 경로를 가리키기만 한다 (영상→음성→텍스트 연결용).
 */
export async function adoptExtractedAudio(
  session: Session,
): Promise<StoredTranscript[]> {
  const already = new Set(
    orderedTranscripts(session).map((item) => item.audioPath),
  );
  const added: StoredTranscript[] = [];

  for (const file of completedFiles(session)) {
    if (!file.outputPath || already.has(file.outputPath)) continue;
    const stat = await fs.stat(file.outputPath).catch(() => null);
    if (!stat) continue;
    added.push(
      registerTranscript(session, {
        originalName: file.outputName,
        audioPath: file.outputPath,
        sizeBytes: stat.size,
        ownsAudio: false,
        sourceLabel: file.originalName,
      }),
    );
  }
  return added;
}

export async function removeTranscript(
  session: Session,
  fileId: string,
): Promise<void> {
  const item = getTranscript(session, fileId);
  if (item.status === 'processing') {
    throw new HttpError(
      409,
      '처리 중인 파일은 삭제할 수 없습니다.',
      'file_busy',
    );
  }
  await Promise.all([
    // 추출 결과를 빌려 쓰는 항목이면 음성 원본은 건드리지 않는다.
    item.ownsAudio ? fs.rm(item.audioPath, { force: true }) : null,
    item.transcriptPath ? fs.rm(item.transcriptPath, { force: true }) : null,
  ]);
  session.transcripts.delete(fileId);
  session.transcriptOrder = session.transcriptOrder.filter(
    (id) => id !== fileId,
  );
  await refreshCombined(session);
}

export function completedTranscripts(session: Session): StoredTranscript[] {
  return orderedTranscripts(session).filter(
    (item) => item.status === 'done' && item.transcriptPath,
  );
}

export function setCombineEnabled(session: Session, enabled: boolean): void {
  session.combineEnabled = enabled;
}

/** 기존 Colab 합치기 스크립트와 같은 형식. */
function combinedBody(items: StoredTranscript[]): string {
  const divider = '='.repeat(80);
  let out = '';
  for (const item of items) {
    out += '\n\n';
    out += `${divider}\n`;
    out += `파일명: ${item.outputName}\n`;
    out += `${divider}\n\n`;
    out += item.text ?? '';
  }
  return out;
}

/** 통합 파일을 다시 만든다. 대상이 없거나 옵션이 꺼져 있으면 지운다. */
export async function refreshCombined(session: Session): Promise<void> {
  const items = completedTranscripts(session);
  const shouldExist = session.combineEnabled && items.length > 0;

  if (!shouldExist) {
    if (session.combinedPath) {
      await fs.rm(session.combinedPath, { force: true });
      session.combinedPath = null;
    }
    session.combinedCharCount = 0;
    return;
  }

  const target = path.join(session.transcriptsDir, 'combined.txt');
  const body = combinedBody(items);
  await fs.writeFile(target, body, 'utf8');
  session.combinedPath = target;
  session.combinedCharCount = body.length;
}

export function combinedPathOf(session: Session): string {
  if (!session.combinedPath) {
    throw new HttpError(
      409,
      '아직 통합할 받아쓰기 결과가 없습니다.',
      'combined_not_ready',
    );
  }
  return session.combinedPath;
}

async function transcribeOne(
  session: Session,
  item: StoredTranscript,
): Promise<void> {
  item.status = 'processing';
  item.progress = 0;
  item.error = null;
  item.errorCode = null;

  try {
    const exists = await fs
      .stat(item.audioPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      throw new ExtractError(
        'source_missing',
        '음성 파일이 서버에 없습니다. 다시 업로드해주세요.',
      );
    }

    const transcriptPath = path.join(
      session.transcriptsDir,
      `${item.fileId}${TRANSCRIPT_OUTPUT_EXTENSION}`,
    );

    const { segments, duration } = await transcribe({
      audioPath: item.audioPath,
      outputPath: transcriptPath,
      onProgress: (percent) => {
        if (item.status === 'processing') item.progress = percent;
      },
    });

    item.text = await fs.readFile(transcriptPath, 'utf8');
    item.transcriptPath = transcriptPath;
    item.segmentCount = segments;
    item.durationSeconds = duration > 0 ? duration : null;
    item.progress = 100;
    item.status = 'done';
  } catch (cause) {
    item.status = 'failed';
    item.progress = 0;
    if (cause instanceof ExtractError) {
      item.error = cause.message;
      const known: TranscriptErrorCode[] = [
        'source_missing',
        'worker_unavailable',
        'unsupported_format',
      ];
      item.errorCode = known.includes(cause.code as TranscriptErrorCode)
        ? (cause.code as TranscriptErrorCode)
        : 'transcribe_failed';
      if (cause.detail) {
        console.error(`[transcribe] ${item.originalName}: ${cause.detail}`);
      }
    } else {
      item.error = '음성 파일을 처리하지 못했습니다.';
      item.errorCode = 'transcribe_failed';
      console.error(`[transcribe] ${item.originalName}:`, cause);
    }
  }
}

/**
 * 대기 중인 음성을 순서대로 받아쓴다.
 * 모델이 무거워 항상 한 번에 하나씩 처리하고, 한 파일이 실패해도 계속 진행한다.
 */
export function startTranscription(session: Session): void {
  if (session.transcribing) return;
  const queued = orderedTranscripts(session).filter(
    (item) => item.status === 'queued',
  );
  if (queued.length === 0) return;

  session.transcribing = true;
  void (async () => {
    for (const item of queued) {
      session.lastAccessAt = Date.now();
      await transcribeOne(session, item);
    }
    await refreshCombined(session).catch((cause) =>
      console.error('[transcribe] 통합 파일 생성 실패:', cause),
    );
  })()
    .catch((cause) => console.error('[transcribe] 작업 오류:', cause))
    .finally(() => {
      session.transcribing = false;
      session.lastAccessAt = Date.now();
    });
}

