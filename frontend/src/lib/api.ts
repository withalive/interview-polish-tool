import type {
  AuthResponse,
  HealthResponse,
  SessionState,
  TranscriptSessionState,
  TranscriptUploadResponse,
  UploadResponse,
} from '@interview/shared';
import { emitUnauthorized } from './authEvents';

const configuredBase = import.meta.env.VITE_API_BASE_URL?.trim();
const BASE = (configuredBase || '/api').replace(/\/+$/, '');

export const needsApiConfiguration =
  import.meta.env.MODE === 'github-pages' && !configuredBase;

export const API_CONFIGURATION_NOTICE =
  '서버 연결이 아직 설정되지 않아 로그인과 파일 처리를 사용할 수 없습니다.';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (needsApiConfiguration) throw new Error(API_CONFIGURATION_NOTICE);
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    // 세션 쿠키 기반 인증 — 모든 요청에 쿠키를 싣는다.
    credentials: 'include',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    // /auth/* 는 세션을 "확인하는" 경로다. 여기서 나온 401은 세션 만료 신호가
    // 아니라 확인 결과 그 자체이므로 만료 이벤트를 쏘지 않는다.
    // (쏘면 초기 로그인 여부 확인이 스스로를 무효화해 로딩에 갇힌다)
    if (response.status === 401 && !path.startsWith('/auth/')) {
      emitUnauthorized();
    }
    throw new Error(body?.error ?? `요청이 실패했습니다 (${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * 파일 업로드 공용 구현.
 * fetch는 업로드 진행률을 주지 않으므로 XHR을 쓴다 (영상은 수백 MB가 될 수 있다).
 */
function uploadVia<T>(
  url: string,
  files: File[],
  onProgress?: (percent: number) => void,
  field = 'files',
): Promise<T> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const file of files) form.append(field, file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.upload.addEventListener('progress', (event) => {
      if (!onProgress || !event.lengthComputable) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener('load', () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        parsed = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed as T);
        return;
      }
      if (xhr.status === 401) emitUnauthorized();
      reject(
        new Error(
          (parsed as { error?: string } | null)?.error ??
            `업로드에 실패했습니다 (${xhr.status}).`,
        ),
      );
    });
    xhr.addEventListener('error', () =>
      reject(new Error('업로드 중 네트워크 오류가 발생했습니다.')),
    );
    xhr.addEventListener('abort', () =>
      reject(new Error('업로드가 취소되었습니다.')),
    );
    xhr.send(form);
  });
}

export const api = {
  // ── 인증 ──────────────────────────────────────────────────────────────
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),

  me: () => request<AuthResponse>('/auth/me'),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  // ── 작업 ──────────────────────────────────────────────────────────────
  health: () => request<HealthResponse>('/health'),

  createSession: () => request<SessionState>('/sessions', { method: 'POST' }),

  getSession: (sessionId: string) =>
    request<SessionState>(`/sessions/${sessionId}`),

  deleteFile: (sessionId: string, fileId: string) =>
    request<SessionState>(`/sessions/${sessionId}/files/${fileId}`, {
      method: 'DELETE',
    }),

  startExtract: (sessionId: string) =>
    request<SessionState>(`/sessions/${sessionId}/extract`, { method: 'POST' }),

  audioUrl: (sessionId: string, fileId: string, download = false) =>
    `${BASE}/sessions/${sessionId}/files/${fileId}/audio${download ? '?download=1' : ''}`,

  archiveUrl: (sessionId: string) => `${BASE}/sessions/${sessionId}/archive`,

  // ── 텍스트 추출 ────────────────────────────────────────────────────────
  getTranscripts: (sessionId: string) =>
    request<TranscriptSessionState>(`/sessions/${sessionId}/transcripts`),

  deleteTranscript: (sessionId: string, fileId: string) =>
    request<TranscriptSessionState>(
      `/sessions/${sessionId}/transcripts/files/${fileId}`,
      { method: 'DELETE' },
    ),

  setCombine: (sessionId: string, enabled: boolean) =>
    request<TranscriptSessionState>(
      `/sessions/${sessionId}/transcripts/combine`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      },
    ),

  startTranscription: (sessionId: string) =>
    request<TranscriptSessionState>(
      `/sessions/${sessionId}/transcripts/start`,
      { method: 'POST' },
    ),

  /** 음성 추출 결과를 받아쓰기 목록으로 가져온다 (파일 복사 없음). */
  adoptExtracted: (sessionId: string) =>
    request<TranscriptSessionState>(
      `/sessions/${sessionId}/transcripts/adopt`,
      { method: 'POST' },
    ),

  transcriptUrl: (sessionId: string, fileId: string, download = false) =>
    `${BASE}/sessions/${sessionId}/transcripts/files/${fileId}/text${download ? '?download=1' : ''}`,

  combinedUrl: (sessionId: string, download = false) =>
    `${BASE}/sessions/${sessionId}/transcripts/combined${download ? '?download=1' : ''}`,

  transcriptArchiveUrl: (sessionId: string) =>
    `${BASE}/sessions/${sessionId}/transcripts/archive`,

  uploadAudioFiles: (
    sessionId: string,
    files: File[],
    onProgress?: (percent: number) => void,
  ): Promise<TranscriptUploadResponse> =>
    uploadVia(
      `${BASE}/sessions/${sessionId}/transcripts/files`,
      files,
      onProgress,
    ),

  /** 영상 업로드. 진행률이 필요해 XHR을 쓴다. */
  uploadFiles: (
    sessionId: string,
    files: File[],
    onProgress?: (percent: number) => void,
  ): Promise<UploadResponse> =>
    uploadVia(`${BASE}/sessions/${sessionId}/files`, files, onProgress),
};
