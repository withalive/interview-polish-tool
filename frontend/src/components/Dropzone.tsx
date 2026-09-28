import React from 'react';

export default function Dropzone({
  onFiles,
  accept,
  disabled = false,
  hint,
}: {
  onFiles: (files: File[]) => void;
  /** 허용 확장자 목록 (예: ['.mp4', '.mov']). */
  accept: readonly string[];
  disabled?: boolean;
  hint?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);

  const pick = (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (files.length > 0) onFiles(files);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    pick(event.dataTransfer.files);
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`rounded-lg border border-dashed p-10 text-center transition ${
        dragging
          ? 'border-sky-400 bg-sky-50'
          : 'border-slate-300 bg-white hover:border-slate-400'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      <p className="text-sm text-slate-600">
        {hint ?? '파일을 여기로 끌어다 놓거나'}
      </p>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="mt-3 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        파일 선택
      </button>
      <p className="mt-3 text-xs text-slate-500">
        여러 개를 한 번에 선택할 수 있습니다 · 지원 형식 {accept.join(' ')}
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept.join(',')}
        className="hidden"
        onChange={(event) => {
          pick(event.target.files);
          // 같은 파일을 연속으로 다시 선택할 수 있게 비운다.
          event.target.value = '';
        }}
      />
    </div>
  );
}
