import { spawn } from 'node:child_process';
import { FFMPEG_AUDIO_ARGS, type FfmpegHealth } from '@interview/shared';
import { config } from '../config.js';
import { ExtractError } from './errors.js';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  onStdoutChunk?: (chunk: string) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      onStdoutChunk?.(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      // stderr는 길어질 수 있어 뒤쪽만 남긴다.
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let cachedHealth: FfmpegHealth | null = null;

/** ffmpeg 사용 가능 여부. 결과는 캐시한다. */
export async function checkFfmpeg(force = false): Promise<FfmpegHealth> {
  if (cachedHealth && !force) return cachedHealth;
  try {
    const { code, stdout } = await run(config.ffmpegPath, ['-version']);
    if (code !== 0) throw new Error(`exit ${code}`);
    const version = /^ffmpeg version (\S+)/.exec(stdout)?.[1] ?? null;
    cachedHealth = { available: true, version, path: config.ffmpegPath };
  } catch {
    cachedHealth = { available: false, version: null, path: config.ffmpegPath };
  }
  return cachedHealth;
}

export interface ProbeResult {
  hasAudio: boolean;
  durationSeconds: number | null;
}

/** 오디오 스트림 존재 여부와 길이를 확인한다. */
export async function probe(input: string): Promise<ProbeResult> {
  const { code, stdout, stderr } = await run(config.ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    input,
  ]);

  if (code !== 0) {
    throw new ExtractError(
      'probe_failed',
      '영상 정보를 읽을 수 없습니다. 파일이 손상되었을 수 있습니다.',
      stderr,
    );
  }

  let parsed: {
    streams?: { codec_type?: string }[];
    format?: { duration?: string };
  };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new ExtractError(
      'probe_failed',
      '영상 정보를 해석할 수 없습니다.',
      stdout.slice(0, 500),
    );
  }

  const hasAudio = (parsed.streams ?? []).some(
    (stream) => stream.codec_type === 'audio',
  );
  const rawDuration = Number(parsed.format?.duration);
  const durationSeconds =
    Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;

  return { hasAudio, durationSeconds };
}

/** "00:01:23.456" → 83.456 */
function parseTimecode(value: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

export interface ExtractOptions {
  input: string;
  output: string;
  durationSeconds: number | null;
  onProgress?: (percent: number) => void;
}

/**
 * 기존 Colab 설정과 동일하게 음성만 추출한다.
 * ffmpeg -y -i <input> -vn -ac 1 -ar 16000 -c:a aac -b:a 32k <output>.m4a
 */
export async function extractAudio(options: ExtractOptions): Promise<void> {
  const { input, output, durationSeconds, onProgress } = options;

  let carry = '';
  const handleChunk = (chunk: string) => {
    if (!onProgress || !durationSeconds) return;
    carry += chunk;
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      const [key, value] = line.split('=');
      if (key?.trim() !== 'out_time' || value === undefined) continue;
      const seconds = parseTimecode(value);
      if (seconds === null) continue;
      const percent = Math.min(
        99,
        Math.max(0, Math.round((seconds / durationSeconds) * 100)),
      );
      onProgress(percent);
    }
  };

  const args = [
    '-y',
    '-i',
    input,
    ...FFMPEG_AUDIO_ARGS,
    '-progress',
    'pipe:1',
    '-nostats',
    output,
  ];

  let result: RunResult;
  try {
    result = await run(config.ffmpegPath, args, handleChunk);
  } catch (cause) {
    throw new ExtractError(
      'ffmpeg_unavailable',
      'ffmpeg를 실행할 수 없습니다. 설치 여부를 확인해주세요.',
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  if (result.code !== 0) {
    throw new ExtractError(
      'ffmpeg_failed',
      '음성 변환에 실패했습니다.',
      result.stderr.slice(-2000),
    );
  }
}
