"""받아쓰기 워커.

Node 백엔드가 이 프로세스를 한 번만 띄우고 계속 재사용한다.
모델(large-v3)은 프로세스당 한 번만 로드된다 — 파일마다 다시 만들지 않는다.

프로토콜 (stdin/stdout 각각 JSON Lines):
  요청 : {"id": "<작업 id>", "audio": "<입력 경로>", "output": "<출력 txt 경로>"}
  응답 : {"type": "ready"}                          모델 로딩 완료
         {"type": "progress", "id": ..., "percent": 0-99}
         {"type": "done", "id": ..., "segments": n, "duration": s}
         {"type": "error", "id": ..., "message": "...", "detail": "..."}

경로는 Node 가 ASCII 안전한 이름(<fileId>.m4a / <fileId>.txt)으로만 넘긴다.
한글 원본 파일명은 Node 쪽 메타데이터에만 있으므로 여기서는 인코딩 문제가 없다.
그래도 외부에서 직접 쓸 때를 대비해 경로는 NFC 로 정규화한다.
"""

import json
import os
import sys
import traceback
import unicodedata

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "ko")
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))
VAD_FILTER = os.environ.get("WHISPER_VAD_FILTER", "true").lower() != "false"


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def pick_device():
    """기존 Colab 코드와 같은 기준. torch 가 없으면 ctranslate2 로 판정한다."""
    device_override = os.environ.get("WHISPER_DEVICE")
    if device_override:
        compute = os.environ.get(
            "WHISPER_COMPUTE_TYPE",
            "float16" if device_override == "cuda" else "int8",
        )
        return device_override, compute

    cuda = False
    try:
        import torch  # noqa: PLC0415

        cuda = torch.cuda.is_available()
    except Exception:
        try:
            import ctranslate2  # noqa: PLC0415

            cuda = ctranslate2.get_cuda_device_count() > 0
        except Exception:
            cuda = False

    if cuda:
        return "cuda", os.environ.get("WHISPER_COMPUTE_TYPE", "float16")
    return "cpu", os.environ.get("WHISPER_COMPUTE_TYPE", "int8")


def normalize(path):
    return unicodedata.normalize("NFC", path)


def transcribe(model, request):
    audio_path = normalize(request["audio"])
    output_path = normalize(request["output"])
    job_id = request["id"]

    if not os.path.isfile(audio_path):
        raise FileNotFoundError(audio_path)

    segments, info = model.transcribe(
        audio_path,
        language=LANGUAGE,
        beam_size=BEAM_SIZE,
        vad_filter=VAD_FILTER,
    )

    total = getattr(info, "duration", 0) or 0
    written = 0
    last_percent = -1

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    # 도중에 실패하면 반쪽짜리 txt 가 남지 않도록 임시 파일에 쓰고 마지막에 옮긴다.
    temp_path = output_path + ".partial"
    with open(temp_path, "w", encoding="utf-8") as handle:
        for segment in segments:
            start = segment.start
            end = segment.end
            text = segment.text.strip()
            handle.write(f"[{start:.2f} - {end:.2f}] {text}\n")
            written += 1

            if total > 0:
                percent = min(99, int(end / total * 100))
                if percent != last_percent:
                    last_percent = percent
                    emit({"type": "progress", "id": job_id, "percent": percent})

    os.replace(temp_path, output_path)
    return written, total


def main():
    device, compute_type = pick_device()
    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(MODEL_NAME, device=device, compute_type=compute_type)
    except Exception as error:  # 모델 로딩 실패는 치명적 — 알리고 종료한다.
        emit(
            {
                "type": "fatal",
                "message": "받아쓰기 모델을 불러오지 못했습니다.",
                "detail": f"{error}\n{traceback.format_exc()}",
            }
        )
        return 1

    emit(
        {
            "type": "ready",
            "model": MODEL_NAME,
            "device": device,
            "computeType": compute_type,
        }
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        job_id = request.get("id", "?")
        try:
            segments, duration = transcribe(model, request)
            emit(
                {
                    "type": "done",
                    "id": job_id,
                    "segments": segments,
                    "duration": duration,
                }
            )
        except FileNotFoundError as error:
            emit(
                {
                    "type": "error",
                    "id": job_id,
                    "message": "음성 파일을 찾을 수 없습니다.",
                    "detail": str(error),
                }
            )
        except Exception as error:
            # 한 파일이 실패해도 워커는 살아 있어야 다음 파일을 처리한다.
            emit(
                {
                    "type": "error",
                    "id": job_id,
                    "message": "음성 파일을 처리하지 못했습니다.",
                    "detail": f"{error}\n{traceback.format_exc()}",
                }
            )

    return 0


if __name__ == "__main__":
    sys.exit(main())
