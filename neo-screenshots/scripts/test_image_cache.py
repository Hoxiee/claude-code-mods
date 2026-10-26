import base64
import importlib.util
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zlib


SCRIPT = Path(__file__).with_name("image-cache.py")
SPEC = importlib.util.spec_from_file_location("image_cache", SCRIPT)
cache = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cache)


def png(width=4, height=2):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    raw = (b"\x00" + b"\xff\x00\x00" * width) * height
    return b"\x89PNG\r\n\x1a\n" + chunk(
        b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    ) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def payload(data=None, mime="image/png"):
    return {"base64": base64.b64encode(png() if data is None else data).decode(), "mimeType": mime}


class ImageCacheTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="neo-screenshots-tests-")
        self.addCleanup(self.directory.cleanup)
        patch = mock.patch.object(cache.tempfile, "tempdir", self.directory.name)
        patch.start()
        self.addCleanup(patch.stop)

    def snapshot(self):
        return cache.capture(payload())

    def test_capture_keeps_exact_bytes_and_private_permissions(self):
        result = self.snapshot()
        path = Path(result["path"])
        self.assertEqual(path.read_bytes(), png())
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        self.assertEqual(set(result), {"path"})
        self.assertEqual(list(path.parent.iterdir()), [path])

    def test_capture_never_runs_image_processing(self):
        with mock.patch.object(cache.shutil, "which", return_value=None) as which, mock.patch.object(
            cache.subprocess, "run"
        ) as run, mock.patch.object(cache.subprocess, "Popen") as popen:
            result = self.snapshot()
        which.assert_not_called()
        run.assert_not_called()
        popen.assert_not_called()
        self.assertEqual(Path(result["path"]).read_bytes(), png())

    def test_each_snapshot_has_a_new_directory(self):
        first = self.snapshot()
        second = self.snapshot()
        self.assertNotEqual(first["path"], second["path"])
        self.assertTrue(Path(first["path"]).is_file())

    def test_input_validation(self):
        invalid = [
            {}, {"mimeType": []}, payload(mime="image/svg+xml"),
            payload(mime="image/jpeg"), payload(b""), payload(b"not an image"),
            {"mimeType": "image/png", "base64": "%%%"},
            {"mimeType": "image/png", "base64": "ёж"},
        ]
        for item in invalid:
            with self.subTest(item=item):
                with self.assertRaises(ValueError):
                    cache.capture(item)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_decoded_size_limit(self):
        with mock.patch.object(cache, "MAX_BYTES", 4), self.assertRaises(ValueError):
            cache.capture(payload())

    def test_open_is_detached_and_does_not_wait_for_viewer_exit(self):
        saved = self.snapshot()
        child = mock.Mock()
        child.wait.side_effect = subprocess.TimeoutExpired("xdg-open", 0.25)
        with mock.patch.object(cache.shutil, "which", return_value="/usr/bin/xdg-open"), mock.patch.object(
            cache.subprocess, "Popen", return_value=child
        ) as popen:
            self.assertEqual(cache.open_snapshot(saved), {"opened": True})
        self.assertEqual(popen.call_args.args[0], ["/usr/bin/xdg-open", saved["path"]])
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        self.assertTrue(popen.call_args.kwargs["close_fds"])
        for stream in ("stdin", "stdout", "stderr"):
            self.assertEqual(popen.call_args.kwargs[stream], subprocess.DEVNULL)
        self.assertFalse(popen.call_args.kwargs.get("shell", False))

    def test_open_reports_missing_opener_and_immediate_failure(self):
        saved = self.snapshot()
        with mock.patch.object(cache.shutil, "which", return_value=None), self.assertRaises(FileNotFoundError):
            cache.open_snapshot(saved)
        child = mock.Mock()
        child.wait.return_value = 3
        with mock.patch.object(cache.shutil, "which", return_value="xdg-open"), mock.patch.object(
            cache.subprocess, "Popen", return_value=child
        ), self.assertRaises(ValueError):
            cache.open_snapshot(saved)

    def test_open_rejects_other_paths_urls_and_symlinks(self):
        saved = self.snapshot()
        path = Path(saved["path"])
        for name in ["https://example.org/x.png", "/etc/passwd", "snapshot.png", str(path.parent / "run.sh")]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                cache.snapshot_path(name)
        original = path.with_name("original.png")
        path.rename(original)
        path.symlink_to(original)
        with self.assertRaises(ValueError):
            cache.snapshot_path(str(path))

    def test_open_rejects_shared_or_symlinked_cache_directory(self):
        path = Path(self.snapshot()["path"])
        path.parent.chmod(0o755)
        with self.assertRaises(ValueError):
            cache.snapshot_path(str(path))
        path.parent.chmod(0o700)
        real_directory = path.parent.with_name("original-directory")
        path.parent.rename(real_directory)
        path.parent.symlink_to(real_directory, target_is_directory=True)
        with self.assertRaises(ValueError):
            cache.snapshot_path(str(path))

    def test_cli_rejects_invalid_json_without_traceback(self):
        result = subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "capture"],
            input="[]", capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("JSON-объект", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
