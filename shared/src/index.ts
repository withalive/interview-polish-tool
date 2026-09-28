// 프론트엔드와 백엔드가 공유하는 API 계약.

/** 업로드를 허용하는 영상 확장자 (소문자, 점 포함). */
export const SUPPORTED_VIDEO_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.m4v',
  '.mkv',
  '.webm',
] as const;

export type SupportedVideoExtension =
  (typeof SUPPORTED_VIDEO_EXTENSIONS)[number];

/** 추출 결과 확장자. */
export const AUDIO_OUTPUT_EXTENSION = '.m4a';

/**
 * 기존 Colab 스크립트와 동일한 오디오 설정.
 * 영상 제거 / mono / 16 kHz / AAC / 32 kbps.
 * 이 배열이 변환 설정의 단일 진실원천이다.
 */
export const FFMPEG_AUDIO_ARGS = [
  '-vn',
  '-ac',
  '1',
  '-ar',
  '16000',
  '-c:a',
  'aac',
  '-b:a',
  '32k',
] as const;

export type FileStatus = 'queued' | 'processing' | 'done' | 'failed';

export type ExtractErrorCode =
  | 'unsupported_format'
  | 'probe_failed'
  | 'no_audio_stream'
  | 'ffmpeg_failed'
  | 'source_missing'
  | 'ffmpeg_unavailable';

export interface MediaFile {
  fileId: string;
  /** 사용자가 올린 원본 파일명 (UTF-8 NFC). 표시·다운로드에 사용. */
  originalName: string;
  /** 원본 파일명의 확장자만 .m4a로 바꾼 이름. */
  outputName: string;
  sizeBytes: number;
  status: FileStatus;
  /** 0–100. 변환 중에만 의미가 있다. */
  progress: number;
  durationSeconds: number | null;
  outputSizeBytes: number | null;
  /** 사용자에게 보여줄 한국어 실패 메시지. */
  error: string | null;
  errorCode: ExtractErrorCode | null;
}

export interface SessionCounts {
  total: number;
  queued: number;
  processing: number;
  done: number;
  failed: number;
}

export interface SessionState {
  sessionId: string;
  files: MediaFile[];
  /** 추출 작업이 돌고 있는지. */
  running: boolean;
  counts: SessionCounts;
  /** 전체 다운로드 ZIP 파일명. */
  archiveName: string;
}

export interface RejectedUpload {
  originalName: string;
  reason: string;
  code: ExtractErrorCode;
}

export interface UploadResponse {
  session: SessionState;
  rejected: RejectedUpload[];
}

export interface FfmpegHealth {
  available: boolean;
  version: string | null;
  path: string | null;
}

export interface HealthResponse {
  ok: boolean;
  ffmpeg: FfmpegHealth;
  /** 텍스트 추출 워커 상태. 이 타입은 아래에서 정의한다. */
  transcriber: TranscriberHealth;
}

export interface ApiErrorResponse {
  error: string;
  code?: string;
}

// ── 인증 ────────────────────────────────────────────────────────────────

export interface AuthUser {
  email: string;
  groups: string[];
}

export interface LoginRequest {
  email: string;
  password: string;
}

/** 로그인 성공과 /auth/me 응답은 같은 모양이다. */
export type AuthResponse = AuthUser;

// ── 텍스트 추출 (받아쓰기) ──────────────────────────────────────────────

/** 받아쓰기에 올릴 수 있는 음성 확장자. 핵심은 .m4a 이고 나머지는 확장용. */
export const SUPPORTED_AUDIO_EXTENSIONS = [
  '.m4a',
  '.mp3',
  '.wav',
] as const;

export const TRANSCRIPT_OUTPUT_EXTENSION = '.txt';

/** 통합 파일 기본 이름. 공통 접두사를 확신할 수 있을 때만 앞에 붙인다. */
export const COMBINED_TRANSCRIPT_BASENAME = '전체인터뷰';

/** 기존 Colab 스크립트와 동일한 받아쓰기 설정. */
export const WHISPER_DEFAULTS = {
  model: 'large-v3',
  language: 'ko',
  beamSize: 5,
  vadFilter: true,
} as const;

export type TranscriptErrorCode =
  | 'unsupported_format'
  | 'source_missing'
  | 'worker_unavailable'
  | 'transcribe_failed';

export interface TranscriptFile {
  fileId: string;
  /** 사용자가 올린 원본 파일명 (UTF-8 NFC). */
  originalName: string;
  /** 확장자만 .txt 로 바꾼 이름. */
  outputName: string;
  sizeBytes: number;
  status: FileStatus;
  progress: number;
  durationSeconds: number | null;
  segmentCount: number | null;
  /** 완료된 경우 받아쓰기 본문 (브라우저에서 바로 보여주기 위함). */
  text: string | null;
  error: string | null;
  errorCode: TranscriptErrorCode | null;
  /** 음성 추출 단계에서 넘어온 파일이면 그 원본 영상 이름. */
  sourceLabel: string | null;
}

export interface CombinedTranscript {
  fileName: string;
  available: boolean;
  /** 통합 파일의 글자 수. 아직 없으면 0. */
  charCount: number;
}

export interface TranscriptSessionState {
  sessionId: string;
  files: TranscriptFile[];
  running: boolean;
  counts: SessionCounts;
  archiveName: string;
  combined: CombinedTranscript;
  /** 통합 파일을 만들지 여부 (서버가 기억한다). */
  combineEnabled: boolean;
}

export interface TranscriptUploadResponse {
  session: TranscriptSessionState;
  rejected: RejectedUpload[];
}

export interface TranscriberHealth {
  /** 워커를 띄울 수 있는지 (python 실행 파일과 스크립트 존재). */
  available: boolean;
  model: string;
  /** 워커가 이미 떠 있으면 실제 선택된 장치. 아직이면 null. */
  device: string | null;
  reason: string | null;
}

