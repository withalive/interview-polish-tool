import { Router } from 'express';
import type { AuthResponse } from '@interview/shared';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { readToken, signIn, signOut, verify } from '../lib/auth.js';

export const auth = Router();

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.authCookieSecure,
  path: '/',
};

auth.post('/login', (req, res) => {
  const body = req.body as { email?: unknown; password?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? body.email : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!email.trim() || !password) {
    throw new HttpError(
      400,
      '이메일과 비밀번호를 입력해주세요.',
      'missing_credentials',
    );
  }

  const { token, user } = signIn(email, password);
  res.cookie(config.authCookieName, token, {
    ...cookieOptions,
    maxAge: config.authSessionTtlMs,
  });
  res.json(user satisfies AuthResponse);
});

auth.get('/me', (req, res) => {
  const user = verify(readToken(req));
  if (!user) {
    throw new HttpError(
      401,
      '로그인이 필요합니다. 다시 로그인해주세요.',
      'unauthenticated',
    );
  }
  res.json(user satisfies AuthResponse);
});

auth.post('/logout', (req, res) => {
  signOut(readToken(req));
  res.clearCookie(config.authCookieName, cookieOptions);
  res.status(204).end();
});

/** 세션이 살아 있는지만 보는 가벼운 확인 (미들웨어 없이). */
auth.get('/status', (req, res) => {
  const user = verify(readToken(req));
  res.json({ authenticated: Boolean(user), user });
});
