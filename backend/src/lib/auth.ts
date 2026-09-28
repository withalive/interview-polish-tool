import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { AuthUser } from '@interview/shared';
import { config } from '../config.js';
import { HttpError } from './errors.js';

interface Account {
  email: string;
  password: string;
  groups: string[];
}

interface AuthSession {
  token: string;
  user: AuthUser;
  expiresAt: number;
}

/**
 * "이메일:비밀번호:그룹|그룹" 목록을 파싱한다.
 * 그룹은 생략 가능하며, 비밀번호에 콜론이 들어갈 수 있으므로
 * 앞의 이메일과 뒤의 그룹만 떼어 내고 나머지를 비밀번호로 본다.
 */
export function parseAccounts(raw: string): Account[] {
  const accounts: Account[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    if (parts.length < 2) continue;
    const email = (parts.shift() as string).trim().toLowerCase();
    // 마지막 조각이 그룹 목록처럼 보이면 떼어 낸다.
    let groups: string[] = [];
    if (parts.length > 1) {
      const last = parts[parts.length - 1] as string;
      if (/^[A-Za-z0-9_|-]+$/.test(last)) {
        groups = last
          .split('|')
          .map((group) => group.trim())
          .filter(Boolean);
        parts.pop();
      }
    }
    const password = parts.join(':');
    if (!email || !password) continue;
    accounts.push({ email, password, groups });
  }
  return accounts;
}

const accounts = parseAccounts(config.authUsers);

const sessions = new Map<string, AuthSession>();

const digest = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest();

/** 길이를 노출하지 않도록 해시를 비교한다. */
function secretsMatch(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function accountCount(): number {
  return accounts.length;
}

/** 자격 증명을 확인하고 새 세션 토큰을 만든다. */
export function signIn(email: string, password: string): {
  token: string;
  user: AuthUser;
} {
  const normalized = email.trim().toLowerCase();
  const account = accounts.find((entry) => entry.email === normalized);

  // 계정이 없어도 같은 비용을 치러 이메일 존재 여부가 드러나지 않게 한다.
  const expected = account?.password ?? randomBytes(24).toString('hex');
  const ok = secretsMatch(password, expected) && Boolean(account);

  if (!ok || !account) {
    throw new HttpError(
      401,
      '이메일 또는 비밀번호가 올바르지 않습니다.',
      'invalid_credentials',
    );
  }

  const token = randomBytes(32).toString('base64url');
  const user: AuthUser = { email: account.email, groups: account.groups };
  sessions.set(token, {
    token,
    user,
    expiresAt: Date.now() + config.authSessionTtlMs,
  });
  return { token, user };
}

/** 토큰이 살아 있으면 사용자와 만료 시각을 갱신해 돌려준다 (슬라이딩). */
export function verify(token: string | undefined): AuthUser | null {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + config.authSessionTtlMs;
  return session.user;
}

export function signOut(token: string | undefined): void {
  if (token) sessions.delete(token);
}

/** 만료된 세션을 메모리에서 비운다. */
export function sweepAuthSessions(now = Date.now()): number {
  let removed = 0;
  for (const [token, session] of [...sessions]) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
      removed += 1;
    }
  }
  return removed;
}

/** 테스트용 — 모든 로그인 세션을 끊는다. */
export function resetAuthSessionsForTest(): void {
  sessions.clear();
}

export const readToken = (req: {
  cookies?: Record<string, unknown>;
}): string | undefined => {
  const value = req.cookies?.[config.authCookieName];
  return typeof value === 'string' ? value : undefined;
};

/**
 * 로그인하지 않았으면 401. 프론트엔드는 이 응답을 받으면
 * 세션 만료로 보고 로그인 화면으로 돌아간다.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const user = verify(readToken(req));
  if (!user) {
    next(
      new HttpError(
        401,
        '로그인이 필요합니다. 다시 로그인해주세요.',
        'unauthenticated',
      ),
    );
    return;
  }
  next();
};
