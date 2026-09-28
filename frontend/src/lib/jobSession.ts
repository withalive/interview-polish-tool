// 업로드/변환 작업 세션 id 보관 (로그인 세션과는 별개).
// 탭 단위로만 유지하며, 로그아웃 시 지워 다음 사용자가 이전 목록을 보지 않게 한다.

const STORAGE_KEY = 'interview-audio-session';

export function readJobSessionId(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeJobSessionId(sessionId: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, sessionId);
  } catch {
    /* 프라이빗 모드 등 — 저장 실패는 무시한다. */
  }
}

export function clearJobSessionId(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 무시 */
  }
}
