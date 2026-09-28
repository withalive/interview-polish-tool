import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { TranscriptSessionState } from '@interview/shared';
import { api } from '../lib/api';
import { readJobSessionId } from '../lib/jobSession';
// 프롬프트 원문은 일반 텍스트 파일로 둔다 — 수정할 때 코드를 건드릴 필요가 없다.
import promptText from '../prompts/topicSplit.prompt.txt?raw';

const PROMPT_FILE_NAME = '주제나누기_프롬프트.txt';
const CLAUDE_URL = 'https://claude.ai/new';

const STEPS = [
  { no: '①', title: '전체 인터뷰 파일 준비', desc: '전체인터뷰.txt 를 내려받습니다.' },
  { no: '②', title: '주제 나누기 프롬프트 복사', desc: '아래 프롬프트를 복사합니다.' },
  { no: '③', title: 'Claude 에 첨부', desc: '새 대화에 파일을 올리고 프롬프트를 붙여넣습니다.' },
  { no: '④', title: '결과 확인', desc: '주제별 이야기 구성안을 받습니다.' },
];

export default function TopicSplitPage() {
  const sessionId = React.useMemo(() => readJobSessionId(), []);
  const [copied, setCopied] = React.useState(false);
  const [copyError, setCopyError] = React.useState<string | null>(null);

  const query = useQuery({
    queryKey: ['transcripts', sessionId],
    queryFn: () => api.getTranscripts(sessionId as string),
    enabled: Boolean(sessionId),
  });

  const session: TranscriptSessionState | undefined = query.data;
  const combined = session?.combined;
  const hasCombined = Boolean(combined?.available);

  const copyPrompt = async () => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      setCopyError(
        '클립보드 복사에 실패했습니다. 아래 “프롬프트 TXT 다운로드”를 이용해주세요.',
      );
    }
  };

  const downloadPrompt = () => {
    // 서버를 거치지 않고 브라우저에서 바로 파일을 만든다.
    const blob = new Blob([promptText], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = PROMPT_FILE_NAME;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">주제 나누기</h1>
        <p className="mt-1 text-sm text-slate-600">
          추출된 전체 인터뷰 텍스트와 아래 프롬프트를 Claude에 함께 첨부하면, 인터뷰
          내용을 기록 주제별로 정리할 수 있습니다.
        </p>
      </div>

      {/* 전체 흐름 */}
      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step) => (
            <div key={step.no} className="flex gap-3">
              <span className="text-lg text-sky-600">{step.no}</span>
              <div>
                <div className="text-sm font-medium text-slate-900">
                  {step.title}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{step.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* STEP 1 — 인터뷰 파일 */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">
          STEP 1 · 전체 인터뷰 파일 준비
        </h2>

        {query.isLoading && (
          <div className="text-sm text-slate-500">불러오는 중…</div>
        )}

        {!query.isLoading && hasCombined && combined && sessionId && (
          <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium uppercase text-slate-500">
                  준비된 인터뷰 파일
                </div>
                <div className="mt-1 font-medium break-all">
                  {combined.fileName}
                </div>
                <div className="mt-1 text-sm text-slate-600 tabular-nums">
                  총 {combined.charCount.toLocaleString('ko-KR')}자
                </div>
              </div>
              <a
                href={api.combinedUrl(sessionId, true)}
                className="shrink-0 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-sky-700"
              >
                다운로드
              </a>
            </div>
          </div>
        )}

        {!query.isLoading && !hasCombined && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center">
            <p className="text-sm text-slate-600">
              먼저 ‘텍스트 추출’에서 모든 받아쓰기를 하나의 파일로 합쳐주세요.
            </p>
            <Link
              to="/text"
              className="mt-3 inline-block rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100"
            >
              텍스트 추출로 이동
            </Link>
          </div>
        )}
      </section>

      {/* STEP 2 — 프롬프트 */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">
            STEP 2 · Claude에 보낼 프롬프트
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {copied && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                프롬프트가 복사되었습니다.
              </span>
            )}
            <button
              type="button"
              onClick={() => void copyPrompt()}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-sky-700"
            >
              프롬프트 복사
            </button>
            <button
              type="button"
              onClick={downloadPrompt}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100"
            >
              프롬프트 TXT 다운로드
            </button>
          </div>
        </div>

        {copyError && (
          <div className="rounded-md bg-rose-50 p-4 text-sm text-rose-700">
            {copyError}
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <pre className="max-h-96 overflow-auto p-4 text-xs leading-relaxed text-slate-700 whitespace-pre-wrap break-words">
            {promptText}
          </pre>
        </div>
      </section>

      {/* STEP 3~4 — 사용 방법 */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">STEP 3 · 사용 방법</h2>
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
            <li>전체인터뷰.txt 를 다운로드합니다.</li>
            <li>위 “프롬프트 복사”를 누릅니다.</li>
            <li>Claude 새 대화를 엽니다.</li>
            <li>전체인터뷰.txt 를 첨부합니다.</li>
            <li>복사한 프롬프트를 붙여넣습니다.</li>
            <li>결과를 확인합니다.</li>
          </ol>
          <a
            href={CLAUDE_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-block rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100"
          >
            Claude 열기 ↗
          </a>
        </div>
      </section>

      <p className="text-xs text-slate-500">
        현재 버전에서는 별도의 LLM API 비용을 발생시키지 않기 위해 주제 분석을
        Claude에서 직접 진행합니다.
      </p>
    </div>
  );
}
