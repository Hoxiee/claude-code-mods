from __future__ import annotations

import base64
import binascii
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile


PREFIX = "neo-screenshots-"
MAX_BYTES = 32 * 1024 * 1024
MAX_INPUT = (MAX_BYTES + 2) // 3 * 4 + 4096
FORMATS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
}


def decode_image(payload: dict) -> tuple[bytes, str]:
    mime = payload.get("mimeType")
    encoded = payload.get("base64")
    if not isinstance(mime, str) or mime not in FORMATS:
        raise ValueError("Поддерживаются только PNG, JPEG, GIF и WebP")
    if not isinstance(encoded, str) or len(encoded) > (MAX_BYTES + 2) // 3 * 4:
        raise ValueError("Изображение отсутствует или превышает 32 MiB")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("Некорректные данные base64") from error
    if not data or len(data) > MAX_BYTES:
        raise ValueError("Изображение пустое или превышает 32 MiB")
    signatures = {
        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": data.startswith(b"\xff\xd8\xff"),
        "image/gif": data.startswith((b"GIF87a", b"GIF89a")),
        "image/webp": data.startswith(b"RIFF") and data[8:12] == b"WEBP",
    }
    if not signatures[mime]:
        raise ValueError("Сигнатура изображения не соответствует MIME-типу")
    return data, FORMATS[mime]


def capture(payload: dict) -> dict:
    data, extension = decode_image(payload)
    directory = Path(tempfile.mkdtemp(prefix=PREFIX))
    path = directory / f"snapshot.{extension}"
    try:
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
            stream.write(data)
    except OSError:
        shutil.rmtree(directory)
        raise
    return {"path": str(path)}


def snapshot_path(value: object) -> Path:
    if not isinstance(value, str):
        raise ValueError("Не указан путь к сохранённому снимку")
    path = Path(value)
    directory = path.parent
    root = Path(tempfile.gettempdir()).resolve()
    if (
        not path.is_absolute()
        or not directory.name.startswith(PREFIX)
        or directory.parent.resolve() != root
        or directory.is_symlink()
        or path.is_symlink()
        or path.name not in {f"snapshot.{extension}" for extension in FORMATS.values()}
    ):
        raise ValueError("Можно открыть только сохранённый снимок этого списка")
    directory_stat = directory.stat()
    if directory_stat.st_uid != os.getuid() or directory_stat.st_mode & 0o077:
        raise ValueError("Каталог снимка не является приватным")
    if not stat.S_ISREG(path.stat().st_mode):
        raise ValueError("Снимок не найден или не является обычным файлом")
    return path


def open_snapshot(payload: dict) -> dict:
    path = snapshot_path(payload.get("path"))
    opener = shutil.which("xdg-open")
    if opener is None:
        raise FileNotFoundError("Не найден xdg-open; установите xdg-utils")
    process = subprocess.Popen(
        [opener, str(path)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    # Просмотрщик живёт отдельно и не удерживает вызов hook до закрытия окна.
    try:
        code = process.wait(timeout=0.25)
    except subprocess.TimeoutExpired:
        return {"opened": True}
    if code != 0:
        raise ValueError(f"Системный просмотрщик не запустился (код {code})")
    return {"opened": True}


def main() -> int:
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ("capture", "open"):
            raise ValueError("Использование: image-cache.py capture|open")
        raw = sys.stdin.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ValueError("Слишком большой входной запрос")
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("Ожидается JSON-объект")
        result = capture(payload) if sys.argv[1] == "capture" else open_snapshot(payload)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
