import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const num = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  port: num(process.env.PORT, 4000),

  /** 업로드 원본과 추출 결과가 머무는 임시 루트. 영구 보관용이 아니다. */
  storageRoot: process.env.STORAGE_ROOT
    ? path.resolve(process.env.STORAGE_ROOT)
    : path.join(here, '..', 'storage'),

  /** 개별 업로드 파일 크기 상한 (기본 4 GB). */
  maxUploadBytes: num(process.env.MAX_UPLOAD_BYTES, 4 * 1024 * 1024 * 1024),

  /** 한 번에 올릴 수 있는 파일 개수. */
  maxFilesPerUpload: num(process.env.MAX_FILES_PER_UPLOAD, 50),

  /**
   * 마지막 접근(조회·다운로드 포함) 이후 이 시간이 지나면 세션 폴더를 지운다.
   * 다운로드도 접근으로 집계되므로 받는 중에 사라지지 않는다.
   */
  sessionTtlMs: num(process.env.SESSION_TTL_MS, 6 * 60 * 60 * 1000),

  /** 청소 주기. */
  sweepIntervalMs: num(process.env.SWEEP_INTERVAL_MS, 10 * 60 * 1000),

  /** 변환 성공 후 원본 영상을 즉시 지운다 (용량이 큰 쪽부터 비운다). */
  deleteSourceAfterExtract: process.env.DELETE_SOURCE_AFTER_EXTRACT !== 'false',

  /** 동시 변환 개수. 기본 1 = 순차 (CPU 예측 가능). */
  concurrency: num(process.env.EXTRACT_CONCURRENCY, 1),

  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',

  /**
   * 로그인 계정. "이메일:비밀번호:그룹|그룹" 을 쉼표로 구분한다.
   * 사내 네트워크에서만 쓰는 내부 도구라 계정은 환경 변수로만 받는다.
   * 코드에 기본 계정을 두지 않는다. 비어 있으면 아무도 로그인할 수 없고 서버가 경고한다.
   */
  authUsers: process.env.AUTH_USERS ?? '',

  /** 로그인 유지 시간. 요청마다 갱신되는 슬라이딩 방식. */
  authSessionTtlMs: num(process.env.AUTH_SESSION_TTL_MS, 12 * 60 * 60 * 1000),

  authCookieName: process.env.AUTH_COOKIE_NAME ?? 'interview_session',

  /** HTTPS 뒤에 둘 때 켠다. */
  authCookieSecure: process.env.AUTH_COOKIE_SECURE === 'true',

  /** 받아쓰기 워커를 돌릴 파이썬. 기본값은 backend/python/.venv 안의 것. */
  pythonPath:
    process.env.PYTHON_PATH ?? path.join(here, '..', 'python', '.venv', 'bin', 'python'),

  transcribeWorkerScript: path.join(here, '..', 'python', 'transcribe_worker.py'),

  /** Whisper 설정. 워커에 환경 변수로 전달한다. */
  whisperModel: process.env.WHISPER_MODEL ?? 'large-v3',

  /**
   * 워커가 유휴 상태로 이 시간을 넘기면 종료해 메모리(large-v3 는 수 GB)를 돌려준다.
   * 다음 요청에서 다시 띄운다.
   */
  transcriberIdleMs: num(process.env.TRANSCRIBER_IDLE_MS, 30 * 60 * 1000),

  /** 모델 로딩 대기 한도. 첫 실행은 모델 다운로드까지 포함될 수 있다. */
  transcriberStartupMs: num(process.env.TRANSCRIBER_STARTUP_MS, 30 * 60 * 1000),

} as const;
