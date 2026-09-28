import path from 'node:path';
import {
  AUDIO_OUTPUT_EXTENSION,
  COMBINED_TRANSCRIPT_BASENAME,
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  TRANSCRIPT_OUTPUT_EXTENSION,
} from '@interview/shared';

/**
 * latin1로 잘못 디코드된 UTF-8 문자열을 되살린다.
 * 되살릴 수 없으면 null (원본이 이미 올바른 UTF-8이라는 뜻).
 */
function recoverUtf8(raw: string): string | null {
  const bytes = Buffer.from(raw, 'latin1');
  const decoded = bytes.toString('utf8');
  if (decoded.includes('\uFFFD')) return null;
  // 왕복 검증 — 유효한 UTF-8 바이트열이었다면 다시 인코딩해도 같아야 한다.
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) return null;
  return decoded;
}

/**
 * multipart 파일명을 표시 가능한 UTF-8 NFC 문자열로 정규화한다.
 *
 * busboy는 파일명을 latin1으로 디코드하므로 브라우저가 보낸 UTF-8 한글이 깨진다.
 * macOS는 한글을 NFD(자모 분리)로 보내므로 NFC로 합성한다.
 * 디렉터리 성분은 방어적으로 제거한다 (일부 브라우저가 전체 경로를 보낸다).
 */
export function decodeUploadFilename(raw: string): string {
  const withoutDirs = path.basename(raw.replace(/\\/g, '/'));
  // 순수 ASCII면 복구할 것이 없다.
  const candidate = /^[\x20-\x7E]*$/.test(withoutDirs)
    ? withoutDirs
    : (recoverUtf8(withoutDirs) ?? withoutDirs);
  return candidate.normalize('NFC');
}

/** 소문자 확장자 (점 포함). 확장자가 없으면 빈 문자열. */
export function extensionOf(filename: string): string {
  return path.extname(filename).toLowerCase();
}

export function isSupportedVideo(filename: string): boolean {
  const ext = extensionOf(filename);
  return (SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * 확장자만 .m4a로 바꾼다. 원본 이름(한글 포함)은 그대로 유지한다.
 * 문자열 split이 아니라 확장자 길이로 잘라내므로 .mov/.mkv/.webm도 안전하고,
 * 이름 중간에 ".mp4"가 들어간 파일도 깨지지 않는다.
 */
export function toAudioName(filename: string): string {
  const base = path.basename(filename.replace(/\\/g, '/'));
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return `${stem || 'audio'}${AUDIO_OUTPUT_EXTENSION}`;
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0] ?? '';
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/** 마지막 구분자(_ - . 공백) 앞까지 자른다. 구분자가 없으면 그대로. */
function cutAtLastSeparator(value: string): string {
  const match = /^(.*)[\s_\-.]/.exec(value);
  return match?.[1] ?? value;
}

function seoulStamp(at: Date): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  // "2026-09-28 14:05" → "20260928-1405"
  return parts.replace(/[-:]/g, '').replace(' ', '-');
}

/**
 * 전체 다운로드 ZIP 이름.
 * 공통 접두사가 있으면 "강찬석_음성.zip"처럼 사람이 알아보는 이름을 쓰고,
 * 없으면 날짜를 붙인다.
 */
export function archiveNameFor(
  originalNames: string[],
  at: Date = new Date(),
): string {
  const stems = originalNames.map((name) =>
    toAudioName(name).slice(0, -AUDIO_OUTPUT_EXTENSION.length),
  );
  const prefix = commonPrefix(stems).replace(/[\s_\-.]+$/, '');
  const label = cutAtLastSeparator(prefix);
  const picked = label.length >= 2 ? label : prefix;
  if (picked.length >= 2) return `${picked}_음성.zip`;
  return `음성추출_${seoulStamp(at)}.zip`;
}

/**
 * 한글 파일명이 깨지지 않는 Content-Disposition 헤더.
 * ASCII 폴백과 RFC 5987 filename*을 함께 보낸다.
 */
export function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  const kind = inline ? 'inline' : 'attachment';
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ── 텍스트 추출용 ──────────────────────────────────────────────────────

export function isSupportedAudio(filename: string): boolean {
  const ext = extensionOf(filename);
  return (SUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(ext);
}

/** 확장자만 .txt 로 바꾼다. toAudioName 과 같은 방식이라 한글 이름이 유지된다. */
export function toTranscriptName(filename: string): string {
  const base = path.basename(filename.replace(/\\/g, '/'));
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return `${stem || 'transcript'}${TRANSCRIPT_OUTPUT_EXTENSION}`;
}

/** 받아쓰기 ZIP 이름. 음성 쪽과 같은 규칙에 라벨만 다르다. */
export function transcriptArchiveNameFor(
  originalNames: string[],
  at: Date = new Date(),
): string {
  return archiveNameFor(originalNames, at).replace(/_음성\.zip$/, '_받아쓰기.zip');
}

/**
 * 통합 txt 이름.
 * 공통 접두사를 확신할 수 있을 때만 앞에 붙이고, 아니면 기본값을 쓴다
 * (억지로 추측해 이상한 이름을 만들지 않는다).
 */
export function combinedTranscriptName(originalNames: string[]): string {
  const base = `${COMBINED_TRANSCRIPT_BASENAME}${TRANSCRIPT_OUTPUT_EXTENSION}`;
  if (originalNames.length < 2) return base;

  const stems = originalNames.map((name) =>
    toTranscriptName(name).slice(0, -TRANSCRIPT_OUTPUT_EXTENSION.length),
  );
  const prefix = commonPrefix(stems).replace(/[\s_\-.]+$/, '');
  const label = cutAtLastSeparator(prefix);
  return label.length >= 2 ? `${label}_${base}` : base;
}
