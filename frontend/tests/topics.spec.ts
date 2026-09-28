// 주제 나누기 탭 — 외부 LLM API 를 호출하지 않는 "프롬프트 전달" 페이지.
import { expect, test, type Page } from '@playwright/test';
import { TEST_EMAIL, TEST_PASSWORD } from './testAccount';

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[type=email]').fill(TEST_EMAIL);
  await page.locator('input[type=password]').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: /^로그인/ }).click();
  await page.getByRole('heading', { name: '음성 추출', level: 1 }).waitFor();
}

/** 이 페이지에서 나가는 외부 요청을 모두 기록한다. */
async function trackExternal(page: Page): Promise<string[]> {
  const external: string[] = [];
  page.on('request', (request) => {
    const host = new URL(request.url()).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') external.push(request.url());
  });
  return external;
}

test('로그인해야 주제 나누기 페이지를 볼 수 있다', async ({ page }) => {
  await page.goto('/topics');
  await expect(page.getByRole('heading', { name: '로그인', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '주제 나누기' })).toHaveCount(0);
});

test('탭이 세 개이고 주제 나누기가 활성 표시된다', async ({ page }) => {
  await signIn(page);
  const nav = page.locator('header nav');
  await expect(nav.getByRole('link', { name: '음성 추출' })).toBeVisible();
  await expect(nav.getByRole('link', { name: '텍스트 추출' })).toBeVisible();
  await expect(nav.getByRole('link', { name: '주제 나누기' })).toBeVisible();

  await nav.getByRole('link', { name: '주제 나누기' }).click();
  await expect(page.getByRole('heading', { name: '주제 나누기', level: 1 })).toBeVisible();
  // 기존 탭과 같은 active 스타일
  await expect(nav.getByRole('link', { name: '주제 나누기' })).toHaveClass(/bg-sky-100/);
  await expect(nav.getByRole('link', { name: '음성 추출' })).not.toHaveClass(/bg-sky-100/);
});

test('통합 파일이 없으면 텍스트 추출로 안내한다', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: '주제 나누기' }).click();

  await expect(
    page.getByText('먼저 ‘텍스트 추출’에서 모든 받아쓰기를 하나의 파일로 합쳐주세요.'),
  ).toBeVisible();

  await page.getByRole('link', { name: '텍스트 추출로 이동' }).click();
  await expect(page.getByRole('heading', { name: '텍스트 추출', level: 1 })).toBeVisible();
});

test('프롬프트 전문이 보이고 복사·다운로드가 동작한다', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page);
  await page.getByRole('link', { name: '주제 나누기' }).click();

  // 프롬프트의 처음과 끝이 모두 들어 있다 (잘리지 않았다).
  const promptBox = page.locator('pre').first();
  const shown = await promptBox.innerText();
  expect(shown).toContain('당신은 장시간의 생애 인터뷰를');
  expect(shown).toContain('이 검토를 한 뒤 최종 결과만 보여주세요.');
  expect(shown.length).toBeGreaterThan(5000);

  // 내부 스크롤을 쓴다 (페이지 전체를 차지하지 않는다).
  const box = await promptBox.boundingBox();
  expect(box?.height ?? 0).toBeLessThan(600);

  // 복사
  await page.getByRole('button', { name: '프롬프트 복사' }).click();
  await expect(page.getByText('프롬프트가 복사되었습니다.')).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('당신은 장시간의 생애 인터뷰를');
  expect(clipboard).toContain('이 검토를 한 뒤 최종 결과만 보여주세요.');

  // TXT 다운로드 — 화면의 프롬프트와 동일해야 한다
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '프롬프트 TXT 다운로드' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('주제나누기_프롬프트.txt');
  const { readFile } = await import('node:fs/promises');
  const saved = await readFile(await file.path(), 'utf8');
  expect(saved).toContain('당신은 장시간의 생애 인터뷰를');
  expect(saved.trimEnd().endsWith('이 검토를 한 뒤 최종 결과만 보여주세요.')).toBe(true);
});

test('사용 방법과 Claude 링크가 있다', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: '주제 나누기' }).click();

  await expect(page.getByText('전체인터뷰.txt 를 첨부합니다.')).toBeVisible();
  const claude = page.getByRole('link', { name: /Claude 열기/ });
  await expect(claude).toHaveAttribute('href', 'https://claude.ai/new');
  await expect(claude).toHaveAttribute('target', '_blank');

  await expect(
    page.getByText('현재 버전에서는 별도의 LLM API 비용을 발생시키지 않기 위해', {
      exact: false,
    }),
  ).toBeVisible();
});

test('이 페이지는 외부로 어떤 요청도 보내지 않는다', async ({ page }) => {
  await signIn(page);
  const external = await trackExternal(page);

  await page.getByRole('link', { name: '주제 나누기' }).click();
  await page.getByRole('heading', { name: '주제 나누기', level: 1 }).waitFor();
  await page.getByRole('button', { name: '프롬프트 복사' }).click();
  await page.waitForTimeout(1500);

  expect(external).toEqual([]);
});
