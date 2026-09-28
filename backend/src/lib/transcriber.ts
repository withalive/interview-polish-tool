import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { TranscriberHealth } from '@interview/shared';
import { config } from '../config.js';
import { ExtractError } from './errors.js';

interface Job {
  resolve: (value: { segments: number; duration: number }) => void;
  reject: (reason: ExtractError) => void;
  onProgress: ((percent: number) => void) | undefined;
}

interface WorkerEvent {
  type: 'ready' | 'progress' | 'done' | 'error' | 'fatal';
  id?: string;
  percent?: number;
  segments?: number;
  duration?: number;
  message?: string;
  detail?: string;
  model?: string;
  device?: string;
  computeType?: string;
}

let child: ChildProcessWithoutNullStreams | null = null;
let starting: Promise<void> | null = null;
let ready = false;
let device: string | null = null;
const jobs = new Map<string, Job>();
let nextJobId = 0;
let idleTimer: NodeJS.Timeout | null = null;

function failAllJobs(message: string, detail?: string): void {
  for (const [, job] of jobs) {
    job.reject(new ExtractError('transcribe_failed', message, detail));
  }
  jobs.clear();
}

function teardown(reason: string): void {
  ready = false;
  device = null;
  starting = null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const previous = child;
  child = null;
  previous?.removeAllListeners();
  previous?.kill();
  failAllJobs('받아쓰기 처리가 중단되었습니다.', reason);
}

function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (jobs.size > 0) return;
    console.log('[transcriber] 유휴 상태 — 워커를 종료합니다.');
    teardown('idle');
  }, config.transcriberIdleMs);
  idleTimer.unref();
}

function handleEvent(event: WorkerEvent): void {
  if (event.type === 'ready') {
    ready = true;
    device = event.device ?? null;
    console.log(
      `[transcriber] 준비 완료 — model=${event.model} device=${event.device} compute=${event.computeType}`,
    );
    return;
  }
  if (event.type === 'fatal') {
    console.error('[transcriber] 모델 로딩 실패:', event.detail);
    teardown(event.detail ?? 'fatal');
    return;
  }

  const job = event.id ? jobs.get(event.id) : undefined;
  if (!job || !event.id) return;

  if (event.type === 'progress') {
    job.onProgress?.(event.percent ?? 0);
    return;
  }
  if (event.type === 'done') {
    jobs.delete(event.id);
    job.resolve({
      segments: event.segments ?? 0,
      duration: event.duration ?? 0,
    });
    if (jobs.size === 0) scheduleIdleShutdown();
    return;
  }
  if (event.type === 'error') {
    jobs.delete(event.id);
    job.reject(
      new ExtractError(
        'transcribe_failed',
        event.message ?? '음성 파일을 처리하지 못했습니다.',
        event.detail,
      ),
    );
    if (jobs.size === 0) scheduleIdleShutdown();
  }
}

/** 워커를 띄우고 모델 로딩이 끝날 때까지 기다린다. 이미 떠 있으면 바로 반환. */
function ensureWorker(): Promise<void> {
  if (ready && child) return Promise.resolve();
  if (starting) return starting;

  starting = new Promise<void>((resolve, reject) => {
    if (!existsSync(config.pythonPath)) {
      starting = null;
      reject(
        new ExtractError(
          'worker_unavailable',
          '받아쓰기 실행 환경이 준비되지 않았습니다. 관리자에게 문의해주세요.',
          `python not found: ${config.pythonPath}`,
        ),
      );
      return;
    }

    const proc = spawn(
      config.pythonPath,
      ['-u', config.transcribeWorkerScript],
      {
        env: { ...process.env, WHISPER_MODEL: config.whisperModel },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child = proc;

    const timer = setTimeout(() => {
      teardown('startup timeout');
      reject(
        new ExtractError(
          'worker_unavailable',
          '받아쓰기 모델을 준비하지 못했습니다. 잠시 후 다시 시도해주세요.',
          'startup timeout',
        ),
      );
    }, config.transcriberStartupMs);
    timer.unref();

    createInterface({ input: proc.stdout }).on('line', (line) => {
      let event: WorkerEvent;
      try {
        event = JSON.parse(line) as WorkerEvent;
      } catch {
        console.log('[transcriber]', line);
        return;
      }
      handleEvent(event);
      if (event.type === 'ready') {
        clearTimeout(timer);
        resolve();
      }
      if (event.type === 'fatal') {
        clearTimeout(timer);
        reject(
          new ExtractError(
            'worker_unavailable',
            event.message ?? '받아쓰기 모델을 불러오지 못했습니다.',
            event.detail,
          ),
        );
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) console.log('[transcriber:py]', text.slice(-2000));
    });

    proc.on('error', (cause) => {
      clearTimeout(timer);
      teardown(cause.message);
      reject(
        new ExtractError(
          'worker_unavailable',
          '받아쓰기 프로세스를 시작하지 못했습니다.',
          cause.message,
        ),
      );
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (child === proc) teardown(`worker exited with ${code}`);
    });
  });

  return starting;
}

export interface TranscribeOptions {
  audioPath: string;
  outputPath: string;
  onProgress?: (percent: number) => void;
}

/** 한 파일을 받아쓴다. 모델은 프로세스에 한 번만 로드되고 계속 재사용된다. */
export async function transcribe(
  options: TranscribeOptions,
): Promise<{ segments: number; duration: number }> {
  await ensureWorker();
  const proc = child;
  if (!proc || !ready) {
    throw new ExtractError(
      'worker_unavailable',
      '받아쓰기 처리를 시작할 수 없습니다.',
    );
  }

  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  const id = `job-${(nextJobId += 1)}`;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, onProgress: options.onProgress });
    proc.stdin.write(
      `${JSON.stringify({
        id,
        audio: options.audioPath,
        output: options.outputPath,
      })}\n`,
    );
  });
}

export function transcriberHealth(): TranscriberHealth {
  const pythonExists = existsSync(config.pythonPath);
  const scriptExists = existsSync(config.transcribeWorkerScript);
  return {
    available: pythonExists && scriptExists,
    model: config.whisperModel,
    device,
    reason: pythonExists
      ? scriptExists
        ? null
        : '받아쓰기 스크립트를 찾을 수 없습니다.'
      : '받아쓰기용 파이썬 환경이 없습니다. backend/python 의 설치 안내를 따라주세요.',
  };
}

/** 서버 종료 시 워커도 정리한다. */
export function stopTranscriber(): void {
  if (child) teardown('shutdown');
}
