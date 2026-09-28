import assert from 'node:assert/strict';
import test from 'node:test';
import {
  archiveNameFor,
  contentDisposition,
  decodeUploadFilename,
  extensionOf,
  isSupportedVideo,
  toAudioName,
} from '../src/lib/filenames.js';

test('latin1로 깨진 한글 파일명을 복구한다', () => {
  const original = '강찬석_인터뷰1.mp4';
  // busboy가 UTF-8 바이트를 latin1으로 읽었을 때의 문자열을 재현한다.
  const mangled = Buffer.from(original, 'utf8').toString('latin1');
  assert.notEqual(mangled, original);
  assert.equal(decodeUploadFilename(mangled), original);
});

test('이미 올바른 한글 파일명은 그대로 둔다', () => {
  assert.equal(decodeUploadFilename('강찬석_인터뷰2.mov'), '강찬석_인터뷰2.mov');
});

test('macOS가 보내는 NFD 한글을 NFC로 합성한다', () => {
  const nfd = '강찬석.mp4'.normalize('NFD');
  assert.notEqual(nfd, '강찬석.mp4');
  assert.equal(decodeUploadFilename(nfd), '강찬석.mp4');
});

test('디렉터리 성분을 제거한다', () => {
  assert.equal(decodeUploadFilename('C:\\videos\\a.mp4'), 'a.mp4');
  assert.equal(decodeUploadFilename('folder/b.mov'), 'b.mov');
});

test('지원 형식만 통과시킨다', () => {
  for (const ok of ['a.mp4', 'a.MOV', 'a.m4v', 'a.mkv', 'a.webm']) {
    assert.equal(isSupportedVideo(ok), true, ok);
  }
  for (const no of ['a.txt', 'a.mp3', 'a.avi', 'a', 'a.mp4.txt']) {
    assert.equal(isSupportedVideo(no), false, no);
  }
  assert.equal(extensionOf('a.MP4'), '.mp4');
});

test('확장자만 .m4a로 바꾸고 이름은 유지한다', () => {
  assert.equal(toAudioName('강찬석_인터뷰1.mp4'), '강찬석_인터뷰1.m4a');
  assert.equal(toAudioName('a.mov'), 'a.m4a');
  assert.equal(toAudioName('a.mkv'), 'a.m4a');
  assert.equal(toAudioName('a.webm'), 'a.m4a');
  // 이름 중간에 ".mp4"가 들어가도 split 방식처럼 깨지지 않는다.
  assert.equal(toAudioName('backup.mp4.final.mov'), 'backup.mp4.final.m4a');
  // 점이 여러 개인 경우 마지막 확장자만 바꾼다.
  assert.equal(toAudioName('2026.01.02 인터뷰.mp4'), '2026.01.02 인터뷰.m4a');
});

test('ZIP 이름은 공통 접두사에서 뽑는다', () => {
  assert.equal(
    archiveNameFor([
      '강찬석_인터뷰1.mp4',
      '강찬석_인터뷰2.mp4',
      '강찬석_인터뷰3.mp4',
    ]),
    '강찬석_음성.zip',
  );
  assert.equal(archiveNameFor(['강찬석_인터뷰1.mp4']), '강찬석_음성.zip');
});

test('공통 접두사가 없으면 날짜를 붙인다', () => {
  const at = new Date('2026-09-28T05:06:00Z'); // 서울 14:06
  assert.equal(
    archiveNameFor(['a.mp4', 'zzz.mov'], at),
    '음성추출_20260928-1406.zip',
  );
});

test('Content-Disposition에 한글 파일명을 안전하게 담는다', () => {
  const header = contentDisposition('강찬석_인터뷰1.m4a', false);
  assert.match(header, /^attachment; /);
  // ASCII 폴백에는 한글이 남지 않는다.
  const ascii = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
  assert.equal(/[^\x20-\x7E]/.test(ascii), false);
  // RFC 5987 파라미터로 원본 이름을 전달한다.
  const encoded = /filename\*=UTF-8''(\S+)$/.exec(header)?.[1] ?? '';
  assert.equal(decodeURIComponent(encoded), '강찬석_인터뷰1.m4a');
});

test('inline과 attachment를 구분한다', () => {
  assert.match(contentDisposition('a.m4a', true), /^inline; /);
});
