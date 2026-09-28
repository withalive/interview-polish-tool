// 실제 ffmpeg로 변환까지 수행하는 통합 테스트.
// 외부 네트워크를 쓰지 않고, 임시 STORAGE_ROOT만 건드린다.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';
import type { Server } from 'node:http';
import type { SessionState, UploadResponse } from '@interview/shared';
import { TEST_AUTH_USERS, TEST_EMAIL, TEST_PASSWORD } from './testAccount.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
// 테스트 파일마다 자기 폴더만 쓰고 지운다 (.tmp 전체를 지우면 다른 파일의 fixture가 날아간다).
const tmpRoot = path.join(here, '.tmp', 'extract');
const fixtures = path.join(tmpRoot, 'fixtures');

process.env.STORAGE_ROOT = path.join(tmpRoot, 'storage');
process.env.SESSION_TTL_MS = '3600000';
process.env.AUTH_USERS = TEST_AUTH_USERS;

let server: Server;
let base: string;
let cookie = '';
let toState: (s: never) => SessionState;

/** 로그인 쿠키를 실어 보내는 fetch. */
function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie },
  });
}

async function makeVideo(file: string, withAudio: boolean): Promise<void> {
  const args = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=160x120:rate=10:duration=2',
    ...(withAudio
      ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2']
      : []),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    ...(withAudio ? ['-c:a', 'aac', '-shortest'] : []),
    file,
  ];
  await run('ffmpeg', args);
}

before(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(fixtures, { recursive: true });

  await makeVideo(path.join(fixtures, 'with-audio-1.mp4'), true);
  await makeVideo(path.join(fixtures, 'with-audio-2.mov'), true);
  await makeVideo(path.join(fixtures, 'no-audio.mp4'), false);

  const { createApp } = await import('../src/app.js');
  const sessions = await import('../src/lib/sessions.js');
  toState = sessions.toState as unknown as typeof toState;
  await sessions.purgeStorageRoot();

  await new Promise<void>((resolve) => {
    server = createApp().listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;

  // 작업 API는 모두 로그인이 필요하다.
  const signedIn = await apiFetch(`/api/auth/login`, {
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function upload(
  sessionId: string,
  entries: { name: string; file: string }[],
): Promise<UploadResponse> {
  const form = new FormData();
  for (const entry of entries) {
    const bytes = await fs.readFile(entry.file);
    form.append('files', new Blob([bytes]), entry.name);
  }
  const response = await apiFetch(`/api/sessions/${sessionId}/files`, {
    method: 'POST',
    body: form,
  });
  // body는 한 번만 읽을 수 있으므로 먼저 문자열로 받아 둔다.
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text) as UploadResponse;
}

async function waitDone(sessionId: string): Promise<SessionState> {
  for (let i = 0; i < 200; i += 1) {
    const response = await apiFetch(`/api/sessions/${sessionId}`);
    const state = (await response.json()) as SessionState;
    if (!state.running && state.counts.queued === 0) return state;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('변환이 끝나지 않았습니다.');
}

test('ffmpeg와 ffprobe를 쓸 수 있다', async () => {
  const response = await apiFetch(`/api/health`);
  const body = (await response.json()) as { ffmpeg: { available: boolean } };
  assert.equal(body.ffmpeg.available, true);
});

test('한글 파일명 영상을 mono 16kHz AAC .m4a로 변환한다', async () => {
  const created = await apiFetch(`/api/sessions`, { method: 'POST' });
  const { sessionId } = (await created.json()) as SessionState;

  const uploaded = await upload(sessionId, [
    { name: '강찬석_인터뷰1.mp4', file: path.join(fixtures, 'with-audio-1.mp4') },
    { name: '강찬석_인터뷰2.mov', file: path.join(fixtures, 'with-audio-2.mov') },
  ]);

  // 한글 이름과 .m4a 출력명이 보존된다.
  assert.deepEqual(
    uploaded.session.files.map((f) => f.originalName),
    ['강찬석_인터뷰1.mp4', '강찬석_인터뷰2.mov'],
  );
  assert.deepEqual(
    uploaded.session.files.map((f) => f.outputName),
    ['강찬석_인터뷰1.m4a', '강찬석_인터뷰2.m4a'],
  );
  assert.equal(uploaded.session.archiveName, '강찬석_음성.zip');

  const started = await apiFetch(`/api/sessions/${sessionId}/extract`, {
    method: 'POST',
  });
  assert.equal(started.status, 202);

  const state = await waitDone(sessionId);
  assert.equal(state.counts.done, 2, JSON.stringify(state.files));
  assert.equal(state.counts.failed, 0);

  // 결과 오디오의 실제 스펙을 확인한다.
  const first = state.files[0];
  assert.ok(first);
  const audio = await apiFetch(`/api/sessions/${sessionId}/files/${first.fileId}/audio?download=1`,
  );
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/mp4');
  const disposition = audio.headers.get('content-disposition') ?? '';
  assert.match(disposition, /filename\*=UTF-8''/);
  assert.equal(
    decodeURIComponent(
      /filename\*=UTF-8''(\S+)$/.exec(disposition)?.[1] ?? '',
    ),
    '강찬석_인터뷰1.m4a',
  );

  const downloaded = path.join(tmpRoot, 'out.m4a');
  await fs.writeFile(downloaded, Buffer.from(await audio.arrayBuffer()));
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name,channels,sample_rate',
    '-of',
    'json',
    downloaded,
  ]);
  const probed = JSON.parse(stdout) as {
    streams: { codec_name: string; channels: number; sample_rate: string }[];
  };
  assert.equal(probed.streams[0]?.codec_name, 'aac');
  assert.equal(probed.streams[0]?.channels, 1);
  assert.equal(probed.streams[0]?.sample_rate, '16000');
});

test('음성 트랙이 없는 영상만 실패하고 나머지는 계속 진행한다', async () => {
  const created = await apiFetch(`/api/sessions`, { method: 'POST' });
  const { sessionId } = (await created.json()) as SessionState;

  await upload(sessionId, [
    { name: '1_정상.mp4', file: path.join(fixtures, 'with-audio-1.mp4') },
    { name: '2_무음성.mp4', file: path.join(fixtures, 'no-audio.mp4') },
    { name: '3_정상.mp4', file: path.join(fixtures, 'with-audio-2.mov') },
  ]);

  await apiFetch(`/api/sessions/${sessionId}/extract`, { method: 'POST' });
  const state = await waitDone(sessionId);

  const byName = new Map(state.files.map((f) => [f.originalName, f]));
  assert.equal(byName.get('1_정상.mp4')?.status, 'done');
  assert.equal(byName.get('3_정상.mp4')?.status, 'done');

  const failed = byName.get('2_무음성.mp4');
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.errorCode, 'no_audio_stream');
  assert.equal(failed?.error, '이 영상에는 음성 트랙이 없습니다.');

  assert.equal(state.counts.done, 2);
  assert.equal(state.counts.failed, 1);
});

test('지원하지 않는 형식은 업로드 단계에서 걸러낸다', async () => {
  const created = await apiFetch(`/api/sessions`, { method: 'POST' });
  const { sessionId } = (await created.json()) as SessionState;

  const notes = path.join(fixtures, 'notes.txt');
  await fs.writeFile(notes, 'not a video');
  const uploaded = await upload(sessionId, [
    { name: '메모.txt', file: notes },
    { name: '정상.mp4', file: path.join(fixtures, 'with-audio-1.mp4') },
  ]);

  assert.equal(uploaded.session.files.length, 1);
  assert.equal(uploaded.session.files[0]?.originalName, '정상.mp4');
  assert.equal(uploaded.rejected.length, 1);
  assert.equal(uploaded.rejected[0]?.originalName, '메모.txt');
  assert.equal(uploaded.rejected[0]?.code, 'unsupported_format');
});

test('전체 다운로드 ZIP에 한글 이름의 m4a가 담긴다', async () => {
  const created = await apiFetch(`/api/sessions`, { method: 'POST' });
  const { sessionId } = (await created.json()) as SessionState;

  await upload(sessionId, [
    { name: '강찬석_인터뷰1.mp4', file: path.join(fixtures, 'with-audio-1.mp4') },
    { name: '강찬석_인터뷰2.mov', file: path.join(fixtures, 'with-audio-2.mov') },
  ]);
  await apiFetch(`/api/sessions/${sessionId}/extract`, { method: 'POST' });
  await waitDone(sessionId);

  const response = await apiFetch(`/api/sessions/${sessionId}/archive`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  const zip = Buffer.from(await response.arrayBuffer());
  // ZIP 시그니처
  assert.equal(zip.subarray(0, 2).toString(), 'PK');
  // 저장(무압축) 엔트리이므로 UTF-8 파일명이 헤더에 그대로 보인다.
  assert.ok(zip.includes(Buffer.from('강찬석_인터뷰1.m4a', 'utf8')));
  assert.ok(zip.includes(Buffer.from('강찬석_인터뷰2.m4a', 'utf8')));
});

test('파일 삭제와 세션 정리가 디스크를 비운다', async () => {
  const created = await apiFetch(`/api/sessions`, { method: 'POST' });
  const session = (await created.json()) as SessionState;
  const { sessionId } = session;

  const uploaded = await upload(sessionId, [
    { name: '삭제할영상.mp4', file: path.join(fixtures, 'with-audio-1.mp4') },
  ]);
  const fileId = uploaded.session.files[0]?.fileId as string;

  const storageRoot = process.env.STORAGE_ROOT as string;
  const uploadsDir = path.join(storageRoot, sessionId, 'uploads');
  assert.equal((await fs.readdir(uploadsDir)).length, 1);

  const afterDelete = await apiFetch(`/api/sessions/${sessionId}/files/${fileId}`,
    { method: 'DELETE' },
  );
  assert.equal(afterDelete.status, 200);
  assert.equal((await afterDelete.json() as SessionState).files.length, 0);
  assert.equal((await fs.readdir(uploadsDir)).length, 0);

  const destroyed = await apiFetch(`/api/sessions/${sessionId}`, {
    method: 'DELETE',
  });
  assert.equal(destroyed.status, 204);
  await assert.rejects(() => fs.stat(path.join(storageRoot, sessionId)));
});

test('변환 성공 후 원본 영상은 지워지고 결과만 남는다', async () => {
  const created = await apiFetch(`/api/sessions`, { method: 'POST' });
  const { sessionId } = (await created.json()) as SessionState;

  await upload(sessionId, [
    { name: '원본정리.mp4', file: path.join(fixtures, 'with-audio-1.mp4') },
  ]);
  await apiFetch(`/api/sessions/${sessionId}/extract`, { method: 'POST' });
  await waitDone(sessionId);

  const storageRoot = process.env.STORAGE_ROOT as string;
  const uploadsDir = path.join(storageRoot, sessionId, 'uploads');
  const outputsDir = path.join(storageRoot, sessionId, 'outputs');
  assert.equal((await fs.readdir(uploadsDir)).length, 0);
  assert.equal((await fs.readdir(outputsDir)).length, 1);
});

test('없는 세션은 404, 준비되지 않은 결과는 409', async () => {
  const missing = await apiFetch(`/api/sessions/00000000-0000-4000-8000-000000000000`,
  );
  assert.equal(missing.status, 404);

  const created = await apiFetch(`/api/sessions`, { method: 'POST' });
  const { sessionId } = (await created.json()) as SessionState;
  const uploaded = await upload(sessionId, [
    { name: '대기중.mp4', file: path.join(fixtures, 'with-audio-1.mp4') },
  ]);
  const fileId = uploaded.session.files[0]?.fileId as string;

  const notReady = await apiFetch(`/api/sessions/${sessionId}/files/${fileId}/audio`,
  );
  assert.equal(notReady.status, 409);

  const emptyArchive = await apiFetch(`/api/sessions/${sessionId}/archive`,
  );
  assert.equal(emptyArchive.status, 409);
});

test('TTL이 지난 세션은 청소되고 진행 중 세션은 남는다', async () => {
  const sessions = await import('../src/lib/sessions.js');
  const created = await apiFetch(`/api/sessions`, { method: 'POST' });
  const { sessionId } = (await created.json()) as SessionState;

  // 아직 TTL 이내 — 남아 있어야 한다.
  assert.deepEqual(await sessions.sweepSessions(Date.now()), []);
  assert.equal((await apiFetch(`/api/sessions/${sessionId}`)).status, 200);

  // TTL을 넘긴 시각으로 청소하면 사라진다.
  const removed = await sessions.sweepSessions(Date.now() + 3_600_001);
  assert.ok(removed.includes(sessionId));
  assert.equal((await apiFetch(`/api/sessions/${sessionId}`)).status, 404);
  assert.equal(toState !== undefined, true);
});
