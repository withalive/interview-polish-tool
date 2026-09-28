import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SUPPORTED_VIDEO_EXTENSIONS,
  type RejectedUpload,
  type SessionState,
} from '@interview/shared';
import { api } from '../lib/api';
import {
  clearJobSessionId,
  readJobSessionId,
  writeJobSessionId,
} from '../lib/jobSession';
import { formatBytes, formatDuration } from '../lib/format';
import Dropzone from '../components/Dropzone';
import ProgressBar from '../components/ProgressBar';
import StatusBadge from '../components/StatusBadge';

const isSupported = (name: string): boolean => {
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();
  return (SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(ext);
};

export default function AudioExtractPage() {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = React.useState<string | null>(
    readJobSessionId,
  );
  const [bootError, setBootError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [rejected, setRejected] = React.useState<RejectedUpload[]>([]);
  const [uploadPercent, setUploadPercent] = React.useState<number | null>(null);
  const creating = React.useRef(false);

  const health = useQuery({ queryKey: ['health'], queryFn: api.health });
  const ffmpegMissing = health.data ? !health.data.ffmpeg.available : false;

  // 세션 확보 — 없거나 서버에서 사라졌으면 새로 만든다.
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

  const sessionQuery = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.getSession(sessionId as string),
    enabled: Boolean(sessionId),
    refetchInterval: (query) => (query.state.data?.running ? 800 : false),
  });

  // 서버가 재시작되어 세션이 없어진 경우 조용히 새 세션으로 넘어간다.
  React.useEffect(() => {
    if (!sessionQuery.error || !sessionId) return;
    clearJobSessionId();
    setSessionId(null);
  }, [sessionQuery.error, sessionId]);

  const session: SessionState | undefined = sessionQuery.data;
  const files = session?.files ?? [];
  const counts = session?.counts;
  const running = session?.running ?? false;

  const applySession = (next: SessionState) => {
    queryClient.setQueryData(['session', next.sessionId], next);
  };

  const uploadMutation = useMutation({
    mutationFn: (picked: File[]) =>
      api.uploadFiles(sessionId as string, picked, setUploadPercent),
    onSuccess: (response) => {
      setRejected((prev) => [...prev, ...response.rejected]);
      applySession(response.session);
    },
    onError: (cause: Error) => setActionError(cause.message),
    onSettled: () => setUploadPercent(null),
  });

  const deleteMutation = useMutation({
    mutationFn: (fileId: string) =>
      api.deleteFile(sessionId as string, fileId),
    onSuccess: applySession,
    onError: (cause: Error) => setActionError(cause.message),
  });

  const extractMutation = useMutation({
    mutationFn: () => api.startExtract(sessionId as string),
    onSuccess: (next) => {
      applySession(next);
      void sessionQuery.refetch();
    },
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
  const canExtract =
    Boolean(sessionId) && queuedCount > 0 && !running && !uploading;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">음성 추출</h1>
        <p className="mt-1 text-sm text-slate-600">
          인터뷰 영상을 업로드하면 음성 파일로 변환합니다.
        </p>
      </div>

      {ffmpegMissing && (
        <div className="rounded-md bg-rose-50 p-4 text-sm text-rose-700">
          <p className="font-medium">
            서버에 ffmpeg가 설치되어 있지 않아 변환을 실행할 수 없습니다.
          </p>
          <p className="mt-1 text-xs">
            macOS에서는 터미널에{' '}
            <code className="rounded bg-rose-100 px-1">brew install ffmpeg</code>{' '}
            를 실행한 뒤 백엔드를 다시 시작해주세요.
          </p>
        </div>
      )}

      {bootError && (
        <div className="rounded-md bg-rose-50 p-4 text-sm text-rose-700">
          {bootError}
        </div>
      )}

      <Dropzone
        onFiles={handleFiles}
        accept={SUPPORTED_VIDEO_EXTENSIONS}
        hint="영상 파일을 여기로 끌어다 놓거나"
        disabled={!sessionId || uploading}
      />

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
              <p className="font-medium">
                건너뛴 파일 {rejected.length}개
              </p>
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
            <h2 className="text-base font-semibold">업로드한 영상</h2>
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
                      {file.status === 'processing' && (
                        <div className="mt-2 max-w-xs">
                          <ProgressBar percent={file.progress} />
                        </div>
                      )}
                      {file.error && (
                        <div className="mt-1 text-xs text-rose-600">
                          {file.error}
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
                      <StatusBadge status={file.status} />
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

          <button
            type="button"
            disabled={!canExtract || extractMutation.isPending}
            onClick={() => extractMutation.mutate()}
            className="w-full rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {running
              ? '변환 중…'
              : queuedCount > 0
                ? `음성 추출 시작 (${queuedCount}개)`
                : '음성 추출 시작'}
          </button>
          {!running && queuedCount === 0 && files.length > 0 && (
            <p className="text-xs text-slate-500">
              대기 중인 영상이 없습니다. 새 영상을 올리면 이어서 변환합니다.
            </p>
          )}
        </section>
      )}

      {doneFiles.length > 0 && sessionId && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">추출 결과</h2>
            <a
              href={api.archiveUrl(sessionId)}
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-800"
            >
              전체 다운로드 (ZIP)
            </a>
          </div>
          <p className="text-xs text-slate-500">
            ZIP 파일명: {session?.archiveName}
          </p>

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
                      {formatBytes(file.outputSizeBytes ?? 0)} ·{' '}
                      {formatDuration(file.durationSeconds)} · mono 16 kHz AAC
                      32 kbps
                    </div>
                  </div>
                  <a
                    href={api.audioUrl(sessionId, file.fileId, true)}
                    className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100"
                  >
                    다운로드
                  </a>
                </div>
                <audio
                  controls
                  preload="metadata"
                  className="mt-3 w-full"
                  src={api.audioUrl(sessionId, file.fileId)}
                />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
