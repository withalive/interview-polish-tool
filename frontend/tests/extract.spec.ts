import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { TEST_EMAIL, TEST_PASSWORD } from './testAccount';

const run = promisify(execFile);
const fixtures = path.join(import.meta.dirname, '.tmp', 'fixtures');

const VIDEOS = [
  '강찬석_인터뷰1.mp4',
  '강찬석_인터뷰2.mp4',
  '강찬석_인터뷰3.mov',
];

/** 작업 화면은 로그인해야 열린다. */
async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[type=email]').fill(TEST_EMAIL);
  await page.locator('input[type=password]').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: /^로그인/ }).click();
  await page
    .getByRole('heading', { name: '음성 추출', level: 1 })
    .waitFor();
}

test.beforeAll(async () => {
  await fs.mkdir(fixtures, { recursive: true });
  for (const [index, name] of VIDEOS.entries()) {
    await run('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=160x120:rate=10:duration=${index + 1}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${330 + index * 110}:duration=${index + 1}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      path.join(fixtures, name),
    ]);
  }
});

test('영상 3개를 올려 음성을 추출하고 재생·개별·전체 다운로드까지 동작한다', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await signIn(page);
  await expect(
    page.getByRole('heading', { name: '음성 추출', level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText('인터뷰 영상을 업로드하면 음성 파일로 변환합니다.'),
  ).toBeVisible();

  // ffmpeg 경고 배너가 뜨지 않아야 한다 (서버에 ffmpeg가 있다).
  await expect(page.getByText('ffmpeg가 설치되어 있지 않아')).toHaveCount(0);

  // 1) 영상 3개 선택
  await page
    .locator('input[type=file]')
    .setInputFiles(VIDEOS.map((name) => path.join(fixtures, name)));

  // 2) 업로드 목록 확인 — 한글 파일명이 깨지지 않는다
  await expect(page.getByRole('heading', { name: '업로드한 영상' })).toBeVisible();
  for (const name of VIDEOS) {
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByText('0 / 3 완료')).toBeVisible();
  await expect(page.getByText('대기').first()).toBeVisible();

  // 3) 음성 추출 시작
  await page.getByRole('button', { name: /음성 추출 시작/ }).click();

  // 4) 전체 진행 상황이 3/3이 된다
  await expect(page.getByText('3 / 3 완료')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('완료 ✓')).toHaveCount(3);
  await expect(page.getByText('실패')).toHaveCount(0);

  // 5) 결과 목록에 원본 → .m4a 매핑이 보인다
  await expect(page.getByRole('heading', { name: '추출 결과' })).toBeVisible();
  await expect(page.getByText('→ 강찬석_인터뷰1.m4a')).toBeVisible();
  await expect(page.getByText('→ 강찬석_인터뷰2.m4a')).toBeVisible();
  await expect(page.getByText('→ 강찬석_인터뷰3.m4a')).toBeVisible();
  await expect(page.getByText('ZIP 파일명: 강찬석_음성.zip')).toBeVisible();

  // 6) 브라우저가 실제로 음성을 디코드할 수 있다
  const players = page.locator('audio');
  await expect(players).toHaveCount(3);
  const duration = await players.first().evaluate(async (node) => {
    const audio = node as HTMLAudioElement;
    audio.preload = 'metadata';
    audio.load();
    await new Promise<void>((resolve, reject) => {
      audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
      audio.addEventListener('error', () => reject(new Error('decode 실패')), {
        once: true,
      });
      setTimeout(() => reject(new Error('metadata timeout')), 20_000);
    });
    return audio.duration;
  });
  expect(duration).toBeGreaterThan(0.5);

  // 7) 개별 다운로드
  const single = page.waitForEvent('download');
  await page.getByRole('link', { name: '다운로드', exact: true }).first().click();
  const singleFile = await single;
  expect(singleFile.suggestedFilename()).toBe('강찬석_인터뷰1.m4a');
  const singlePath = await singleFile.path();
  expect((await fs.stat(singlePath)).size).toBeGreaterThan(0);

  // 8) 전체 ZIP 다운로드
  const zip = page.waitForEvent('download');
  await page.getByRole('link', { name: '전체 다운로드 (ZIP)' }).click();
  const zipFile = await zip;
  expect(zipFile.suggestedFilename()).toBe('강찬석_음성.zip');
  const zipBytes = await fs.readFile(await zipFile.path());
  expect(zipBytes.subarray(0, 2).toString()).toBe('PK');
  for (const name of ['강찬석_인터뷰1.m4a', '강찬석_인터뷰2.m4a', '강찬석_인터뷰3.m4a']) {
    expect(zipBytes.includes(Buffer.from(name, 'utf8'))).toBe(true);
  }

  expect(errors).toEqual([]);
});

test('지원하지 않는 형식은 목록에 들어가지 않고 안내만 표시된다', async ({
  page,
}) => {
  const notes = path.join(fixtures, '메모.txt');
  await fs.writeFile(notes, 'not a video');

  await signIn(page);
  await page.locator('input[type=file]').setInputFiles([notes]);

  await expect(page.getByText('건너뛴 파일 1개')).toBeVisible();
  await expect(page.getByText('메모.txt — 지원하지 않는 형식입니다.')).toBeVisible();
  await expect(page.getByRole('heading', { name: '업로드한 영상' })).toHaveCount(0);
});

test('목록에서 영상을 삭제할 수 있다', async ({ page }) => {
  await signIn(page);
  await page
    .locator('input[type=file]')
    .setInputFiles([
      path.join(fixtures, VIDEOS[0]),
      path.join(fixtures, VIDEOS[1]),
    ]);

  await expect(page.getByRole('cell', { name: VIDEOS[0], exact: true })).toBeVisible();
  await page.getByRole('button', { name: '삭제' }).first().click();

  await expect(page.getByRole('cell', { name: VIDEOS[0], exact: true })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: VIDEOS[1], exact: true })).toBeVisible();
  await expect(page.getByText('0 / 1 완료')).toBeVisible();
});
