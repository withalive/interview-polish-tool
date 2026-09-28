import { expect, test } from '@playwright/test';
import { TEST_EMAIL as EMAIL, TEST_PASSWORD as PASSWORD } from './testAccount';

// 기존 프로젝트와 동일하게 label/input이 htmlFor로 묶여 있지 않아 타입으로 찾는다.
const emailBox = (page: import('@playwright/test').Page) =>
  page.locator('input[type=email]');
const passwordBox = (page: import('@playwright/test').Page) =>
  page.locator('input[type=password]');
const submit = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /^로그인/ });

test('로그인 전에는 앱이 아니라 로그인 카드가 보인다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '로그인', level: 1 })).toBeVisible();
  await expect(page.getByText('인터뷰 처리 도구 (내부 도구)')).toBeVisible();
  await expect(emailBox(page)).toBeVisible();
  await expect(passwordBox(page)).toBeVisible();
  // 비밀번호는 마스킹된다
  await expect(passwordBox(page)).toHaveAttribute('type', 'password');
  // 앱 화면은 렌더되지 않는다
  await expect(page.getByRole('heading', { name: '음성 추출' })).toHaveCount(0);
});

test('빈 값으로 제출하면 브라우저 기본 validation이 막는다', async ({ page }) => {
  await page.goto('/');
  await submit(page).click();
  // 제출이 막혀 로그인 화면에 그대로 남는다
  await expect(page.getByRole('heading', { name: '로그인', level: 1 })).toBeVisible();
  const valid = await emailBox(page).evaluate(
    (node) => (node as HTMLInputElement).validity.valueMissing,
  );
  expect(valid).toBe(true);
});

test('잘못된 비밀번호는 버튼 위에 빨간 한 줄로 안내한다', async ({ page }) => {
  await page.goto('/');
  await emailBox(page).fill(EMAIL);
  await passwordBox(page).fill('틀린비밀번호');
  await submit(page).click();

  const message = page.getByText('이메일 또는 비밀번호가 올바르지 않습니다.');
  await expect(message).toBeVisible();
  // 기존 프로젝트와 같은 표현 — toast도 상단 alert도 아닌 작은 빨간 텍스트
  await expect(message).toHaveClass(/text-rose-600/);
  await expect(message).toHaveClass(/text-xs/);
  // 로그인 화면에 머문다
  await expect(page.getByRole('heading', { name: '로그인', level: 1 })).toBeVisible();
});

test('없는 계정도 같은 문구로 응답한다', async ({ page }) => {
  await page.goto('/');
  await emailBox(page).fill('nobody@example.com');
  await passwordBox(page).fill('아무비번');
  await submit(page).click();
  await expect(
    page.getByText('이메일 또는 비밀번호가 올바르지 않습니다.'),
  ).toBeVisible();
});

test('처리 중에는 버튼이 비활성화되고 문구가 바뀐다', async ({ page }) => {
  await page.goto('/');
  // 로그인 응답을 잠시 붙잡아 진행 중 상태를 관찰한다.
  await page.route('**/api/auth/login', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });

  await emailBox(page).fill(EMAIL);
  await passwordBox(page).fill(PASSWORD);
  await submit(page).click();

  const busy = page.getByRole('button', { name: '로그인 중…' });
  await expect(busy).toBeVisible();
  await expect(busy).toBeDisabled();
});

test('Enter 키로 로그인되고, 성공하면 곧바로 음성 추출 화면이 뜬다', async ({
  page,
}) => {
  await page.goto('/');
  await emailBox(page).fill(EMAIL);
  await passwordBox(page).fill(PASSWORD);
  await passwordBox(page).press('Enter');

  await expect(page.getByRole('heading', { name: '음성 추출', level: 1 })).toBeVisible();
  // 성공 토스트나 중간 안내 없이 바로 화면이 바뀐다
  await expect(page.getByRole('heading', { name: '로그인' })).toHaveCount(0);
});

test('헤더에 이메일·admin·로그아웃이 보인다', async ({ page }) => {
  await page.goto('/');
  await emailBox(page).fill(EMAIL);
  await passwordBox(page).fill(PASSWORD);
  await submit(page).click();
  await expect(page.getByRole('heading', { name: '음성 추출', level: 1 })).toBeVisible();

  const header = page.locator('header');
  await expect(header.getByText(EMAIL)).toBeVisible();
  const admin = header.getByText('admin', { exact: true });
  await expect(admin).toBeVisible();
  await expect(admin).toHaveClass(/text-sky-600/);
  await expect(admin).toHaveClass(/text-xs/);
  await expect(header.getByRole('button', { name: '로그아웃' })).toBeVisible();
  // 이전의 "내부 도구" 표시는 없어졌다
  await expect(header.getByText('내부 도구')).toHaveCount(0);
});

test('새로고침해도 로그인이 유지된다', async ({ page }) => {
  await page.goto('/');
  await emailBox(page).fill(EMAIL);
  await passwordBox(page).fill(PASSWORD);
  await submit(page).click();
  await expect(page.getByRole('heading', { name: '음성 추출', level: 1 })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: '음성 추출', level: 1 })).toBeVisible();
});

test('로그아웃하면 로그인 화면으로 돌아가고 뒤로가기로도 못 들어온다', async ({
  page,
}) => {
  await page.goto('/');
  await emailBox(page).fill(EMAIL);
  await passwordBox(page).fill(PASSWORD);
  await submit(page).click();
  await expect(page.getByRole('heading', { name: '음성 추출', level: 1 })).toBeVisible();

  // 되돌아갈 히스토리 항목을 하나 만든다.
  // 같은 URL로 다시 goto 하면 브라우저가 항목을 교체하므로 pushState를 쓴다.
  await page.evaluate(() => history.pushState({}, '', '/#work'));

  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('heading', { name: '로그인', level: 1 })).toBeVisible();

  // 뒤로가기로 앱 화면에 닿을 수 없다
  await page.goBack();
  await expect(page.getByRole('heading', { name: '음성 추출' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '로그인', level: 1 })).toBeVisible();

  // 주소를 직접 쳐도 마찬가지
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '로그인', level: 1 })).toBeVisible();
});

test('세션이 끊기면 안내와 함께 로그인 화면으로 돌아간다', async ({ page }) => {
  await page.goto('/');
  await emailBox(page).fill(EMAIL);
  await passwordBox(page).fill(PASSWORD);
  await submit(page).click();
  await expect(page.getByRole('heading', { name: '음성 추출', level: 1 })).toBeVisible();

  // 서버가 세션을 잃은 상황을 재현한다.
  await page.route('**/api/sessions**', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: '로그인이 필요합니다. 다시 로그인해주세요.',
        code: 'unauthenticated',
      }),
    }),
  );
  await page.reload();

  await expect(page.getByRole('heading', { name: '로그인', level: 1 })).toBeVisible();
  await expect(
    page.getByText('세션이 만료되었습니다. 다시 로그인해주세요.'),
  ).toBeVisible();
});
