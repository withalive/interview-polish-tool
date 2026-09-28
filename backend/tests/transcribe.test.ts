// 실제 faster-whisper 워커로 받아쓰기까지 수행하는 통합 테스트.
// 모델은 tiny 로 고정한다 — 파이프라인 검증이 목적이고 large-v3 는 CPU 에서 너무 느리다.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';
import type { Server } from 'node:http';
import type { TranscriptSessionState, TranscriptUploadResponse } from '@interview/shared';
import { TEST_AUTH_USERS, TEST_EMAIL, TEST_PASSWORD } from './testAccount.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, '.tmp', 'transcribe');
const fixtures = path.join(tmpRoot, 'fixtures');

process.env.STORAGE_ROOT = path.join(tmpRoot, 'storage');
process.env.WHISPER_MODEL = 'tiny';
process.env.AUTH_USERS = TEST_AUTH_USERS;

let server: Server;
let base: string;
let cookie = '';
let hasSpeech = false;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie },
  });
}

/** macOS 의 say 로 한국어 음성을 만든다. 없으면 톤으로 대체한다. */
async function makeAudio(target: string, text: string): Promise<boolean> {
  const aiff = `${target}.aiff`;
  try {
    await run('say', ['-v', 'Yuna', '-o', aiff, text]);
    await run('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', aiff,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '32k', target,
    ]);
    return true;
  } catch {
    await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '32k', target,
    ]);
    return false;
  }
}

before(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(fixtures, { recursive: true });

  hasSpeech = await makeAudio(
    path.join(fixtures, 'speech1.m4a'),
    '안녕하세요. 저는 강찬석입니다.',
  );
  await makeAudio(
    path.join(fixtures, 'speech2.m4a'),
    '오늘은 날씨가 아주 좋습니다.',
  );
  // 받아쓸 수 없는 깨진 파일 — 실패 격리 확인용.
  await fs.writeFile(path.join(fixtures, 'broken.m4a'), 'not audio at all');

  const { createApp } = await import('../src/app.js');
  const sessions = await import('../src/lib/sessions.js');
  await sessions.purgeStorageRoot();

  await new Promise<void>((resolve) => {
    server = createApp().listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;

  const signedIn = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    }),
  });
  if (!signedIn.ok) throw new Error('테스트 로그인 실패');
  cookie = (signedIn.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(';')[0])
    .join('; ');
});

after(async () => {
  const { stopTranscriber } = await import('../src/lib/transcriber.js');
  stopTranscriber();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function newSession(): Promise<string> {
  const created = await call('/api/sessions', { method: 'POST' });
  return ((await created.json()) as { sessionId: string }).sessionId;
}

async function upload(
  sessionId: string,
  entries: { name: string; file: string }[],
): Promise<TranscriptUploadResponse> {
  const form = new FormData();
  for (const entry of entries) {
    form.append('files', new Blob([await fs.readFile(entry.file)]), entry.name);
  }
  const response = await call(`/api/sessions/${sessionId}/transcripts/files`, {
    method: 'POST',
    body: form,
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text) as TranscriptUploadResponse;
}

async function waitDone(sessionId: string): Promise<TranscriptSessionState> {
  // 모델 로딩 + CPU 추론을 감안해 넉넉히 기다린다.
  for (let i = 0; i < 600; i += 1) {
    const response = await call(`/api/sessions/${sessionId}/transcripts`);
    const state = (await response.json()) as TranscriptSessionState;
    if (!state.running && state.counts.queued === 0) return state;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('받아쓰기가 끝나지 않았습니다.');
}

test('받아쓰기 없이는 목록이 비어 있고 통합 옵션은 꺼져 있다', async () => {
  const sessionId = await newSession();
  const response = await call(`/api/sessions/${sessionId}/transcripts`);
  const state = (await response.json()) as TranscriptSessionState;
  assert.equal(state.files.length, 0);
  assert.equal(state.combineEnabled, false);
  assert.equal(state.combined.available, false);
  assert.equal(state.combined.fileName, '전체인터뷰.txt');
});

test('한글 이름의 m4a 를 받아쓰고 txt 로 만든다', async () => {
  const sessionId = await newSession();
  const uploaded = await upload(sessionId, [
    { name: '강찬석_인터뷰1.m4a', file: path.join(fixtures, 'speech1.m4a') },
  ]);

  assert.equal(uploaded.session.files[0]?.originalName, '강찬석_인터뷰1.m4a');
  assert.equal(uploaded.session.files[0]?.outputName, '강찬석_인터뷰1.txt');

  const started = await call(`/api/sessions/${sessionId}/transcripts/start`, {
    method: 'POST',
  });
  assert.equal(started.status, 202);

  const state = await waitDone(sessionId);
  assert.equal(state.counts.done, 1, JSON.stringify(state.files));

  const file = state.files[0];
  assert.ok(file);
  assert.equal(file.status, 'done');
  assert.ok(file.text !== null);

  if (hasSpeech) {
    // [시작 - 끝] 문장 형식이 기존 Colab 스크립트와 같아야 한다.
    assert.match(file.text as string, /^\[\d+\.\d{2} - \d+\.\d{2}\] .+/m);
    assert.ok((file.segmentCount ?? 0) > 0);
  }

  // 개별 txt 다운로드
  const download = await call(
    `/api/sessions/${sessionId}/transcripts/files/${file.fileId}/text?download=1`,
  );
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') ?? '', /text\/plain/);
  const disposition = download.headers.get('content-disposition') ?? '';
  assert.equal(
    decodeURIComponent(/filename\*=UTF-8''(\S+)$/.exec(disposition)?.[1] ?? ''),
    '강찬석_인터뷰1.txt',
  );
  assert.equal(await download.text(), file.text);
});

test('한 파일이 실패해도 나머지는 계속 처리된다', async () => {
  const sessionId = await newSession();
  await upload(sessionId, [
    { name: '1_정상.m4a', file: path.join(fixtures, 'speech1.m4a') },
    { name: '2_깨짐.m4a', file: path.join(fixtures, 'broken.m4a') },
    { name: '3_정상.m4a', file: path.join(fixtures, 'speech2.m4a') },
  ]);
  await call(`/api/sessions/${sessionId}/transcripts/start`, { method: 'POST' });

  const state = await waitDone(sessionId);
  const byName = new Map(state.files.map((f) => [f.originalName, f]));
  assert.equal(byName.get('1_정상.m4a')?.status, 'done');
  assert.equal(byName.get('3_정상.m4a')?.status, 'done');

  const failed = byName.get('2_깨짐.m4a');
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.errorCode, 'transcribe_failed');
  assert.equal(failed?.error, '음성 파일을 처리하지 못했습니다.');

  assert.equal(state.counts.done, 2);
  assert.equal(state.counts.failed, 1);
});

test('통합 옵션을 켜면 Colab 과 같은 형식의 전체 txt 를 만든다', async () => {
  const sessionId = await newSession();
  await upload(sessionId, [
    { name: '강찬석_인터뷰1.m4a', file: path.join(fixtures, 'speech1.m4a') },
    { name: '강찬석_인터뷰2.m4a', file: path.join(fixtures, 'speech2.m4a') },
  ]);

  const enabled = await call(
    `/api/sessions/${sessionId}/transcripts/combine`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    },
  );
  const withOption = (await enabled.json()) as TranscriptSessionState;
  assert.equal(withOption.combineEnabled, true);
  // 공통 접두사가 뚜렷하면 앞에 붙인다.
  assert.equal(withOption.combined.fileName, '강찬석_전체인터뷰.txt');

  await call(`/api/sessions/${sessionId}/transcripts/start`, { method: 'POST' });
  const state = await waitDone(sessionId);
  assert.equal(state.counts.done, 2);
  assert.equal(state.combined.available, true);

  const combined = await call(
    `/api/sessions/${sessionId}/transcripts/combined`,
  );
  assert.equal(combined.status, 200);
  const body = await combined.text();
  const divider = '='.repeat(80);
  assert.ok(body.includes(`${divider}\n파일명: 강찬석_인터뷰1.txt\n${divider}`));
  assert.ok(body.includes(`${divider}\n파일명: 강찬석_인터뷰2.txt\n${divider}`));
  // 개별 결과가 순서대로 들어 있어야 한다.
  assert.ok(
    body.indexOf('강찬석_인터뷰1.txt') < body.indexOf('강찬석_인터뷰2.txt'),
  );
});

test('ZIP 에 개별 txt 와 통합 txt 가 함께 담긴다', async () => {
  const sessionId = await newSession();
  await upload(sessionId, [
    { name: '강찬석_인터뷰1.m4a', file: path.join(fixtures, 'speech1.m4a') },
    { name: '강찬석_인터뷰2.m4a', file: path.join(fixtures, 'speech2.m4a') },
  ]);
  await call(`/api/sessions/${sessionId}/transcripts/combine`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  await call(`/api/sessions/${sessionId}/transcripts/start`, { method: 'POST' });
  const state = await waitDone(sessionId);
  assert.equal(state.counts.done, 2);

  const response = await call(`/api/sessions/${sessionId}/transcripts/archive`);
  assert.equal(response.status, 200);
  const zip = Buffer.from(await response.arrayBuffer());
  assert.equal(zip.subarray(0, 2).toString(), 'PK');
  for (const name of [
    '강찬석_인터뷰1.txt',
    '강찬석_인터뷰2.txt',
    '강찬석_전체인터뷰.txt',
  ]) {
    assert.ok(zip.includes(Buffer.from(name, 'utf8')), name);
  }
});

test('음성 추출 결과를 복사 없이 받아쓰기 목록으로 가져온다', async () => {
  const sessionId = await newSession();

  // 음성 추출 단계를 먼저 돌린다.
  const video = path.join(fixtures, 'clip.mp4');
  await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video,
  ]);
  const form = new FormData();
  form.append('files', new Blob([await fs.readFile(video)]), '회의영상.mp4');
  await call(`/api/sessions/${sessionId}/files`, { method: 'POST', body: form });
  await call(`/api/sessions/${sessionId}/extract`, { method: 'POST' });

  for (let i = 0; i < 100; i += 1) {
    const r = await call(`/api/sessions/${sessionId}`);
    const s = (await r.json()) as { running: boolean; counts: { queued: number } };
    if (!s.running && s.counts.queued === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const adopted = await call(
    `/api/sessions/${sessionId}/transcripts/adopt`,
    { method: 'POST' },
  );
  assert.equal(adopted.status, 201);
  const state = (await adopted.json()) as TranscriptSessionState;
  assert.equal(state.files.length, 1);
  assert.equal(state.files[0]?.originalName, '회의영상.m4a');
  assert.equal(state.files[0]?.outputName, '회의영상.txt');
  // 어느 영상에서 왔는지 표시된다.
  assert.equal(state.files[0]?.sourceLabel, '회의영상.mp4');

  // 파일을 복사하지 않았으므로 audio/ 폴더는 비어 있다.
  const audioDir = path.join(
    process.env.STORAGE_ROOT as string,
    sessionId,
    'audio',
  );
  assert.equal((await fs.readdir(audioDir)).length, 0);

  // 두 번 가져와도 중복으로 쌓이지 않는다.
  const again = await call(`/api/sessions/${sessionId}/transcripts/adopt`, {
    method: 'POST',
  });
  assert.equal(again.status, 409);
});

test('지원하지 않는 형식은 업로드 단계에서 걸러낸다', async () => {
  const sessionId = await newSession();
  const notes = path.join(fixtures, '메모.txt');
  await fs.writeFile(notes, 'not audio');
  const uploaded = await upload(sessionId, [
    { name: '메모.txt', file: notes },
    { name: '정상.m4a', file: path.join(fixtures, 'speech1.m4a') },
  ]);
  assert.equal(uploaded.session.files.length, 1);
  assert.equal(uploaded.rejected[0]?.originalName, '메모.txt');
  assert.equal(uploaded.rejected[0]?.code, 'unsupported_format');
});

test('받아쓰기 API 도 로그인 없이는 401', async () => {
  const sessionId = await newSession();
  for (const [p, init] of [
    [`/api/sessions/${sessionId}/transcripts`, {}],
    [`/api/sessions/${sessionId}/transcripts/start`, { method: 'POST' }],
    [`/api/sessions/${sessionId}/transcripts/archive`, {}],
    [`/api/sessions/${sessionId}/transcripts/combined`, {}],
    [`/api/sessions/${sessionId}/transcripts/adopt`, { method: 'POST' }],
  ] as const) {
    const response = await fetch(`${base}${p}`, init);
    assert.equal(response.status, 401, p);
  }
});
