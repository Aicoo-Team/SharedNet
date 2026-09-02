"""Application service for Room messaging, artifacts, and obligations."""

from __future__ import annotations

from collections.abc import AsyncIterable
import re
from typing import TYPE_CHECKING, BinaryIO

if TYPE_CHECKING:
    from ..control.models import ActorIdentity

from .blobs import LocalBlobStore
from .errors import RoomError
from .models import (
    Artifact,
    Message,
    MessagePage,
    RuntimeIdentity,
    normalize_tags,
    parse_cursor,
    validate_filename,
)
from .store import RoomStore


_MEDIA_TYPE = re.compile(
    r"[A-Za-z0-9!#$%&'*+.^_`|~-]+/[A-Za-z0-9!#$%&'*+.^_`|~-]+",
    re.ASCII,
)


def _error(code: str, message: str) -> RoomError:
    return RoomError(code, message, 400)


class RoomService:
    def __init__(self, store: RoomStore, blob_store: LocalBlobStore) -> None:
        self.store = store
        self.blob_store = blob_store

    def post_message(
        self,
        identity: RuntimeIdentity | ActorIdentity,
        room_id: str,
        content: str,
        reply_to: str | None = None,
        tags: object = (),
        attachment_ids: object = (),
    ) -> Message:
        normalized_tags = normalize_tags(tags)
        if not isinstance(attachment_ids, (list, tuple)):
            raise _error("invalid_attachment", "attachment_ids must be a list")
        return self.store.post_message(
            identity,
            room_id,
            content,
            reply_to,
            normalized_tags,
            tuple(attachment_ids),
        )

    def retrieve_messages(
        self,
        identity: RuntimeIdentity | ActorIdentity,
        room_id: str,
        after_cursor: str | None = None,
        limit: int = 50,
    ) -> MessagePage:
        after_sequence = parse_cursor(after_cursor)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise _error("invalid_limit", "limit must be between 1 and 100")
        return self.store.retrieve_messages(identity, room_id, after_sequence, limit)

    def resolve_message(
        self,
        identity: RuntimeIdentity | ActorIdentity,
        room_id: str,
        message_id: str,
        outcome: str,
        evidence: str | None = None,
    ) -> Message:
        return self.store.resolve_message(identity, room_id, message_id, outcome, evidence)

    async def upload_artifact(
        self,
        identity: RuntimeIdentity | ActorIdentity,
        room_id: str,
        filename: str,
        media_type: str,
        chunks: AsyncIterable[bytes],
    ) -> Artifact:
        filename = validate_filename(filename)
        if not isinstance(media_type, str) or _MEDIA_TYPE.fullmatch(media_type) is None:
            raise _error("invalid_media_type", "media_type must be an ASCII type/subtype")

        self.store.require_artifact_upload_access(identity, room_id)
        stored_blob = await self.blob_store.store_stream(chunks)
        return self.store.create_artifact(
            identity,
            room_id,
            filename,
            media_type,
            stored_blob.size_bytes,
            stored_blob.sha256,
        )

    def open_artifact(
        self,
        identity: RuntimeIdentity | ActorIdentity,
        room_id: str,
        artifact_id: str,
    ) -> tuple[Artifact, BinaryIO]:
        artifact = self.store.get_artifact(identity, room_id, artifact_id)
        return artifact, self.blob_store.open_blob(artifact.sha256)
