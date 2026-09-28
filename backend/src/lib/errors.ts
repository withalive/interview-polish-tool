import type {
  ExtractErrorCode,
  TranscriptErrorCode,
} from '@interview/shared';

/** 음성 추출과 텍스트 추출이 같은 예외 타입을 공유한다. */
export type JobErrorCode = ExtractErrorCode | TranscriptErrorCode;

/** 사용자에게 한국어 메시지를 그대로 보여줄 수 있는 실패. */
export class ExtractError extends Error {
  readonly code: JobErrorCode;
  /** 로그용 상세 (ffmpeg stderr 등). 사용자에게는 보여주지 않는다. */
  readonly detail: string | undefined;

  constructor(code: JobErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'ExtractError';
    this.code = code;
    this.detail = detail;
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
