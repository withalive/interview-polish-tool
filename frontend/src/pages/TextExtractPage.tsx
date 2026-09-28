import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  WHISPER_DEFAULTS,
  type RejectedUpload,
  type TranscriptSessionState,
} from '@interview/shared';
import { api } from '../lib/api';
import { formatBytes, formatDuration } from '../lib/format';
import {
  clearJobSessionId,
  readJobSessionId,
  writeJobSessionId,
} from '../lib/jobSession';
import Dropzone from '../components/Dropzone';
import ProgressBar from '../components/ProgressBar';
import StatusBadge from '../components/StatusBadge';

const STATUS_LABELS = { processing: '텍스트 추출 중…' } as const;

const isSupported = (name: string): boolean => {
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();
  return (SUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(ext);
};

function CopyButton({
  text,
  label = '텍스트 복사',
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => setCopied(false),
        );
      }}
      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100"
    >
      {copied ? '복사됨 ✓' : label}
    </button>
  );
}

export default function TextExtractPage() {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = React.useState<string | null>(
    readJobSessionId,
  );
  const [bootError, setBootError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [rejected, setRejected] = React.useState<RejectedUpload[]>([]);
  const [uploadPercent, setUploadPercent] = React.useState<number | null>(null);
  const [combinedOpen, setCombinedOpen] = React.useState(false);
  const [combinedText, setCombinedText] = React.useState<string | null>(null);
  /**
   * 체크박스의 "의도"를 즉시 반영하기 위한 로컬 상태.
   * 서버 응답만 바라보면 쿼리 캐시 알림이 마이크로태스크로 밀려
   * 체크가 한 박자 늦게 들어간다. 응답이 오면 null 로 되돌려 서버 값을 따른다.
   */
  const [combineWanted, setCombineWanted] = React.useState<boolean | null>(
    null,
  );
  const creating = React.useRef(false);

  const health = useQuery({ queryKey: ['health'], queryFn: api.health });
  const transcriber = health.data?.transcriber;

  React.useEffect(() => {
    if (sessionId || creating.current) return;
    creating.current = true;
    void api
      .createSession()
      .then((session) => {
        setSessionId(session.sessionId);
        setBootError(null);
        writeJobSessionId(session.sessionId);
      })
      .catch((cause: unknown) =>
        setBootError(
          cause instanceof Error
            ? cause.message
            : '서버에 연결할 수 없습니다. 백엔드가 실행 중인지 확인해주세요.',
        ),
      )
      .finally(() => {
        creating.current = false;
      });
  }, [sessionId]);

  const query = useQuery({
    queryKey: ['transcripts', sessionId],
    queryFn: () => api.getTranscripts(sessionId as string),
    enabled: Boolean(sessionId),
    // 받아쓰기는 파일당 수 분이 걸릴 수 있어 폴링으로 상태를 따라간다.
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });

  React.useEffect(() => {
    if (!query.error || !sessionId) return;
    clearJobSessionId();
    setSessionId(null);
  }, [query.error, sessionId]);

  const session: TranscriptSessionState | undefined = query.data;
  const files = session?.files ?? [];
  const counts = session?.counts;
  const running = session?.running ?? false;

  const apply = (next: TranscriptSessionState) => {
    queryClient.setQueryData(['transcripts', next.sessionId], next);
  };

  const uploadMutation = useMutation({
    mutationFn: (picked: File[]) =>
      api.uploadAudioFiles(sessionId as string, picked, setUploadPercent),
    onSuccess: (response) => {
      setRejected((prev) => [...prev, ...response.rejected]);
      apply(response.session);
    },
    onError: (cause: Error) => setActionError(cause.message),
    onSettled: () => setUploadPercent(null),
  });

  const deleteMutation = useMutation({
    mutationFn: (fileId: string) =>
      api.deleteTranscript(sessionId as string, fileId),
    onSuccess: apply,
    onError: (cause: Error) => setActionError(cause.message),
  });

  const combineMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api.setCombine(sessionId as string, enabled),
    onSuccess: (next) => {
      apply(next);
      setCombinedText(null);
    },
    onError: (cause: Error) => setActionError(cause.message),
    // 성공이든 실패든 서버 값으로 되돌아간다.
    onSettled: () => setCombineWanted(null),
  });

  const startMutation = useMutation({
    mutationFn: () => api.startTranscription(sessionId as string),
    onSuccess: (next) => {
      apply(next);
      void query.refetch();
    },
    onError: (cause: Error) => setActionError(cause.message),
  });

  const adoptMutation = useMutation({
    mutationFn: () => api.adoptExtracted(sessionId as string),
    onSuccess: apply,
    onError: (cause: Error) => setActionError(cause.message),
  });

  const handleFiles = (picked: File[]) => {
    setActionError(null);
    const supported = picked.filter((file) => isSupported(file.name));
    const unsupported = picked.filter((file) => !isSupported(file.name));
    if (unsupported.length > 0) {
      setRejected((prev) => [
        ...prev,
        ...unsupported.map((file) => ({
          originalName: file.name,
          code: 'unsupported_format' as const,
          reason: '지원하지 않는 형식입니다.',
        })),
      ]);
    }
    if (supported.length > 0) uploadMutation.mutate(supported);
  };

  const uploading = uploadPercent !== null;
  const queuedCount = counts?.queued ?? 0;
  const doneFiles = files.filter((file) => file.status === 'done');
  const canStart =
    Boolean(sessionId) && queuedCount > 0 && !running && !uploading;

  const showCombined =
    session?.combineEnabled && session.combined.available && !running;

  const loadCombined = async () => {
    if (!sessionId) return;
    setCombinedOpen((open) => !open);
    if (combinedText !== null) return;
    try {
      const response = await fetch(api.combinedUrl(sessionId), {
        credentials: 'include',
      });
      if (!response.ok) throw new Error('전체 텍스트를 불러오지 못했습니다.');
      setCombinedText(await response.text());
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : '전체 텍스트 로딩 실패',
      );
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">텍스트 추출</h1>
        <p className="mt-1 text-sm text-slate-600">
          음성 파일을 업로드하면 인터뷰 내용을 텍스트로 변환합니다.
        </p>
      </div>

      {transcriber && !transcriber.available && (
        <div className="rounded-md bg-rose-50 p-4 text-sm text-rose-700">
          <p className="font-medium">
            서버에 받아쓰기 환경이 준비되지 않아 변환을 실행할 수 없습니다.
          </p>
          <p className="mt-1 text-xs">{transcriber.reason}</p>
        </div>
      )}

      {bootError && (
        <div className="rounded-md bg-rose-50 p-4 text-sm text-rose-700">
          {bootError}
        </div>
      )}

      <Dropzone
        onFiles={handleFiles}
        accept={SUPPORTED_AUDIO_EXTENSIONS}
        hint="음성 파일을 여기로 끌어다 놓거나"
        disabled={!sessionId || uploading}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!sessionId || adoptMutation.isPending || running}
          onClick={() => {
            setActionError(null);
            adoptMutation.mutate();
          }}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          음성 추출 결과 가져오기
        </button>
        <span className="text-xs text-slate-500">
          이 세션의 음성 추출 탭에서 만든 m4a를 그대로 목록에 추가합니다.
        </span>
      </div>

      {uploading && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-slate-700">업로드 중…</span>
            <span className="tabular-nums text-slate-500">
              {uploadPercent}%
            </span>
          </div>
          <ProgressBar percent={uploadPercent ?? 0} />
        </div>
      )}

      {rejected.length > 0 && (
        <div className="rounded-md bg-amber-50 p-4 text-sm text-amber-800">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium">건너뛴 파일 {rejected.length}개</p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {rejected.map((item, index) => (
                  <li key={`${item.originalName}-${index}`}>
                    {item.originalName} — {item.reason}
                  </li>
                ))}
              </ul>
            </div>
            <button
              type="button"
              onClick={() => setRejected([])}
              className="shrink-0 text-xs text-amber-700 underline"
            >
              닫기
            </button>
          </div>
        </div>
      )}

      {actionError && (
        <div className="rounded-md bg-rose-50 p-4 text-sm text-rose-700">
          {actionError}
        </div>
      )}

      {files.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">업로드한 음성</h2>
            {counts && (
              <span className="text-sm text-slate-600 tabular-nums">
                {counts.done} / {counts.total} 완료
                {counts.failed > 0 && (
                  <span className="ml-2 text-rose-600">
                    실패 {counts.failed}
                  </span>
                )}
              </span>
            )}
          </div>

          {counts && counts.total > 0 && (
            <ProgressBar
              percent={((counts.done + counts.failed) / counts.total) * 100}
              tone={counts.failed > 0 ? 'sky' : 'emerald'}
            />
          )}

          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">파일명</th>
                  <th className="px-4 py-3 text-left font-medium">크기</th>
                  <th className="px-4 py-3 text-left font-medium">길이</th>
                  <th className="px-4 py-3 text-left font-medium">상태</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {files.map((file) => (
                  <tr key={file.fileId} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-medium break-all">
                        {file.originalName}
                      </div>
                      {file.sourceLabel && (
                        <div className="mt-0.5 text-xs text-slate-500 break-all">
                          음성 추출: {file.sourceLabel}
                        </div>
                      )}
                      {file.status === 'processing' && (
                        <div className="mt-2 max-w-xs">
                          <ProgressBar percent={file.progress} />
                        </div>
                      )}
                      {file.error && (
                        <div className="mt-1 text-xs text-rose-600">
                          텍스트 추출 실패 — {file.error}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                      {formatBytes(file.sizeBytes)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-600 tabular-nums">
                      {formatDuration(file.durationSeconds)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={file.status} labels={STATUS_LABELS} />
                      {file.status === 'processing' && (
                        <span className="ml-2 text-xs text-slate-500 tabular-nums">
                          {file.progress}%
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        disabled={
                          file.status === 'processing' ||
                          deleteMutation.isPending
                        }
                        onClick={() => deleteMutation.mutate(file.fileId)}
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={combineWanted ?? session?.combineEnabled ?? false}
              disabled={running}
              onChange={(event) => {
                const enabled = event.target.checked;
                setCombineWanted(enabled);
                combineMutation.mutate(enabled);
              }}
              className="h-4 w-4 rounded border-slate-300 accent-sky-600"
            />
            모든 받아쓰기를 하나의 파일로 합치기
            {session && (
              <span className="text-xs text-slate-500">
                ({session.combined.fileName})
              </span>
            )}
          </label>

          <button
            type="button"
            disabled={!canStart || startMutation.isPending}
            onClick={() => startMutation.mutate()}
            className="w-full rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {running
              ? '텍스트 추출 중…'
              : queuedCount > 0
                ? `텍스트 추출 시작 (${queuedCount}개)`
                : '텍스트 추출 시작'}
          </button>
          {running && (
            <p className="text-xs text-slate-500">
              {WHISPER_DEFAULTS.model} 모델로 처리 중입니다. 파일 길이에 따라
              수 분 이상 걸릴 수 있으며, 이 화면을 열어두지 않아도 서버에서
              계속 진행됩니다.
            </p>
          )}
          {!running && queuedCount === 0 && files.length > 0 && (
            <p className="text-xs text-slate-500">
              대기 중인 음성이 없습니다. 새 음성을 올리면 이어서 변환합니다.
            </p>
          )}
        </section>
      )}

      {doneFiles.length > 0 && sessionId && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">추출 결과</h2>
            <a
              href={api.transcriptArchiveUrl(sessionId)}
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-800"
            >
              전체 다운로드 (ZIP)
            </a>
          </div>

          <div className="space-y-3">
            {doneFiles.map((file) => (
              <div
                key={file.fileId}
                className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-slate-500 break-all">
                      {file.originalName}
                    </div>
                    <div className="mt-0.5 font-medium break-all">
                      → {file.outputName}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 tabular-nums">
                      {file.segmentCount ?? 0}개 구간 ·{' '}
                      {formatDuration(file.durationSeconds)}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <CopyButton text={file.text ?? ''} />
                    <a
                      href={api.transcriptUrl(sessionId, file.fileId, true)}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100"
                    >
                      TXT 다운로드
                    </a>
                  </div>
                </div>
                <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-slate-50 p-3 text-xs leading-relaxed text-slate-700 whitespace-pre-wrap break-words">
                  {file.text}
                </pre>
              </div>
            ))}
          </div>
        </section>
      )}

      {showCombined && sessionId && session && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold">전체 인터뷰</h2>
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-medium break-all">
                {session.combined.fileName}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void loadCombined()}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100"
                >
                  {combinedOpen ? '전체 텍스트 접기' : '전체 텍스트 보기'}
                </button>
                {combinedText !== null && (
                  <CopyButton text={combinedText} label="전체 텍스트 복사" />
                )}
                <a
                  href={api.combinedUrl(sessionId, true)}
                  className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-800"
                >
                  {session.combined.fileName} 다운로드
                </a>
              </div>
            </div>
            {combinedOpen && (
              <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-slate-50 p-3 text-xs leading-relaxed text-slate-700 whitespace-pre-wrap break-words">
                {combinedText ?? '불러오는 중…'}
              </pre>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
