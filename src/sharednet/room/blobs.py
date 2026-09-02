"""Streamed, content-addressed local blob persistence for Rooms."""

from __future__ import annotations

from collections.abc import AsyncIterable
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import tempfile
from typing import BinaryIO

from .errors import RoomError


_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _error(code: str, message: str, status_code: int) -> RoomError:
    return RoomError(code, message, status_code)


@dataclass(frozen=True)
class StoredBlob:
    sha256: str
    size_bytes: int


class LocalBlobStore:
    def __init__(self, root: Path, max_upload_bytes: int = 268_435_456) -> None:
        if (
            isinstance(max_upload_bytes, bool)
            or not isinstance(max_upload_bytes, int)
            or max_upload_bytes < 0
        ):
            raise ValueError("max_upload_bytes must be a nonnegative integer")
        self.root = Path(root)
        self.max_upload_bytes = max_upload_bytes
        self._temporary_root = self.root / ".tmp"
        self._content_root = self.root / "sha256"
        self._temporary_root.mkdir(parents=True, exist_ok=True)
        self._content_root.mkdir(parents=True, exist_ok=True)

    async def store_stream(self, chunks: AsyncIterable[bytes]) -> StoredBlob:
        descriptor, temporary_name = tempfile.mkstemp(dir=self._temporary_root)
        temporary_path = Path(temporary_name)
        digest = hashlib.sha256()
        size_bytes = 0
        try:
            with os.fdopen(descriptor, "wb") as temporary_file:
                async for chunk in chunks:
                    if not isinstance(chunk, bytes):
                        raise _error(
                            "invalid_upload_chunk",
                            "upload chunks must be bytes",
                            400,
                        )
                    size_bytes += len(chunk)
                    if size_bytes > self.max_upload_bytes:
                        raise _error(
                            "upload_too_large",
                            "upload exceeds the configured size limit",
                            413,
                        )
                    digest.update(chunk)
                    temporary_file.write(chunk)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())

            sha256 = digest.hexdigest()
            destination = self._blob_path(sha256)
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(temporary_path, destination)
            return StoredBlob(sha256=sha256, size_bytes=size_bytes)
        finally:
            temporary_path.unlink(missing_ok=True)

    def open_blob(self, sha256: str) -> BinaryIO:
        if not isinstance(sha256, str) or _SHA256.fullmatch(sha256) is None:
            raise _error("invalid_sha256", "sha256 must be lowercase hexadecimal", 400)
        try:
            return self._blob_path(sha256).open("rb")
        except FileNotFoundError as error:
            raise _error("artifact_blob_not_found", "artifact blob does not exist", 404) from error

    def _blob_path(self, sha256: str) -> Path:
        return self._content_root / sha256[:2] / sha256
