import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { Server } from 'node:http';
import type { AuthUser } from '@interview/shared';
import { TEST_AUTH_USERS, TEST_EMAIL, TEST_PASSWORD } from './testAccount.js';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.STORAGE_ROOT = path.join(here, '.tmp', 'auth', 'storage');
process.env.AUTH_USERS = TEST_AUTH_USERS;

let server: Server;
let base: string;

const cookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(';')[0])
    .join('; ');

async function login(
  email = TEST_EMAIL,
  password = TEST_PASSWORD,
): Promise<Response> {
  return fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

before(async () => {
  const { createApp } = await import('../src/app.js');
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('계정 문자열을 파싱한다', async () => {
  const { parseAccounts } = await import('../src/lib/auth.js');

  assert.deepEqual(parseAccounts('a@b.com:pw:admin'), [
    { email: 'a@b.com', password: 'pw', groups: ['admin'] },
  ]);
  // 그룹 생략
  assert.deepEqual(parseAccounts('a@b.com:pw'), [
    { email: 'a@b.com', password: 'pw', groups: [] },
  ]);
  // 그룹 여러 개
  assert.deepEqual(parseAccounts('a@b.com:pw:admin|editor')[0]?.groups, [
    'admin',
    'editor',
  ]);
  // 비밀번호에 콜론이 있어도 그룹만 떼어 낸다
  assert.deepEqual(parseAccounts('a@b.com:p:w:d:admin'), [
    { email: 'a@b.com', password: 'p:w:d', groups: ['admin'] },
  ]);
  // 이메일은 소문자로 정규화한다
  assert.equal(parseAccounts('A@B.com:pw')[0]?.email, 'a@b.com');
  // 여러 계정 / 빈 항목 무시
  assert.equal(parseAccounts('a@b.com:1, c@d.com:2 ,,').length, 2);
});

test('올바른 자격 증명으로 로그인하면 사용자와 쿠키를 받는다', async () => {
  const response = await login();
  assert.equal(response.status, 200);

  const user = (await response.json()) as AuthUser;
  assert.equal(user.email, TEST_EMAIL);
  assert.deepEqual(user.groups, ['admin']);

  const setCookie = response.headers.getSetCookie?.() ?? [];
  assert.equal(setCookie.length, 1);
  // 브라우저 스크립트가 세션 토큰을 읽지 못하게 한다.
  assert.match(setCookie[0] as string, /HttpOnly/i);
  assert.match(setCookie[0] as string, /SameSite=Lax/i);
});

test('잘못된 비밀번호와 없는 계정은 같은 메시지로 거절한다', async () => {
  const wrongPassword = await login(TEST_EMAIL, '틀린비번');
  assert.equal(wrongPassword.status, 401);
  const a = (await wrongPassword.json()) as { error: string; code: string };
  assert.equal(a.error, '이메일 또는 비밀번호가 올바르지 않습니다.');
  assert.equal(a.code, 'invalid_credentials');

  const noSuchUser = await login('없는사람@example.com', TEST_PASSWORD);
  assert.equal(noSuchUser.status, 401);
  const b = (await noSuchUser.json()) as { error: string };
  // 계정 존재 여부가 드러나지 않도록 문구가 같아야 한다.
  assert.equal(b.error, a.error);
});

test('이메일 대소문자는 구분하지 않는다', async () => {
  const response = await login('Tester@Example.com', TEST_PASSWORD);
  assert.equal(response.status, 200);
});

test('빈 값은 400으로 막는다', async () => {
  const response = await login('', '');
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, '이메일과 비밀번호를 입력해주세요.');
});

test('쿠키 없이 작업 API에 접근하면 401', async () => {
  for (const [path, init] of [
    ['/api/sessions', { method: 'POST' }],
    ['/api/sessions/anything', {}],
    ['/api/auth/me', {}],
  ] as const) {
    const response = await fetch(`${base}${path}`, init);
    assert.equal(response.status, 401, path);
    const body = (await response.json()) as { error: string; code: string };
    assert.equal(body.code, 'unauthenticated');
    assert.equal(body.error, '로그인이 필요합니다. 다시 로그인해주세요.');
  }
});

test('health 는 로그인 없이도 볼 수 있다', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
});

test('로그인 후 /auth/me 가 사용자를 돌려준다', async () => {
  const cookie = cookieHeader(await login());
  const response = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const user = (await response.json()) as AuthUser;
  assert.equal(user.email, TEST_EMAIL);
});

test('로그아웃하면 세션이 즉시 무효가 된다', async () => {
  const cookie = cookieHeader(await login());
  assert.equal(
    (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).status,
    200,
  );

  const out = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(out.status, 204);

  // 같은 쿠키를 다시 보내도 통하지 않는다 (서버에서 토큰을 지웠다).
  assert.equal(
    (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).status,
    401,
  );
  assert.equal(
    (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { cookie } }))
      .status,
    401,
  );
});

test('만료된 세션은 401이 된다', async () => {
  const { sweepAuthSessions } = await import('../src/lib/auth.js');
  const cookie = cookieHeader(await login());
  assert.equal(
    (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).status,
    200,
  );

  // TTL(12시간)을 넘긴 시점으로 청소하면 세션이 사라진다.
  const removed = sweepAuthSessions(Date.now() + 13 * 60 * 60 * 1000);
  assert.ok(removed > 0);
  assert.equal(
    (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).status,
    401,
  );
});

test('위조한 토큰은 통하지 않는다', async () => {
  const response = await fetch(`${base}/api/auth/me`, {
    headers: { cookie: 'interview_session=aaaaaaaaaaaaaaaaaaaaaaaa' },
  });
  assert.equal(response.status, 401);
});
