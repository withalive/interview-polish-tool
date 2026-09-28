import { config } from './config.js';
import { createApp } from './app.js';
import { checkFfmpeg } from './lib/ffmpeg.js';
import { purgeStorageRoot, sweepSessions } from './lib/sessions.js';
import { accountCount, sweepAuthSessions } from './lib/auth.js';
import { stopTranscriber, transcriberHealth } from './lib/transcriber.js';

// 이전 실행이 남긴 임시 파일부터 비운다.
await purgeStorageRoot();

const ffmpeg = await checkFfmpeg();
if (ffmpeg.available) {
  console.log(`[server] ffmpeg ${ffmpeg.version ?? '?'} (${ffmpeg.path})`);
} else {
  console.warn(
    `[server] ffmpeg를 찾을 수 없습니다 (${ffmpeg.path}). 변환 요청은 거부됩니다.\n` +
      '          macOS: brew install ffmpeg',
  );
}

if (accountCount() === 0) {
  console.warn(
    '[server] 로그인 계정이 없습니다 — AUTH_USERS 가 비었거나 형식이 틀렸습니다.\n' +
      '          backend/.env.example 을 backend/.env 로 복사해 AUTH_USERS 를 지정해주세요.',
  );
} else {
  console.log(`[server] 로그인 계정 ${accountCount()}개 로드`);
}

const transcriber = transcriberHealth();
if (transcriber.available) {
  console.log(
    `[server] 받아쓰기 준비됨 — model=${transcriber.model} (첫 요청 때 로딩)`,
  );
} else {
  console.warn(`[server] 받아쓰기 사용 불가 — ${transcriber.reason}`);
}

// 서버가 내려갈 때 파이썬 워커도 같이 정리한다.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopTranscriber();
    process.exit(0);
  });
}

const timer = setInterval(() => {
  sweepAuthSessions();
  void sweepSessions()
    .then((removed) => {
      if (removed.length > 0) {
        console.log(`[sweep] 작업 세션 ${removed.length}개 정리`);
      }
    })
    .catch((cause) => console.error('[sweep] 실패:', cause));
}, config.sweepIntervalMs);
timer.unref();

createApp().listen(config.port, () => {
  console.log(`[server] http://127.0.0.1:${config.port}`);
  console.log(`[server] 임시 폴더: ${config.storageRoot}`);
});
