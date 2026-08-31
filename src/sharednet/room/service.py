"""Application service for Room messaging and obligation resolution."""

from __future__ import annotations

from .errors import RoomError
from .models import Message, MessagePage, RuntimeIdentity, normalize_tags, parse_cursor
from .store import RoomStore


def _error(code: str, message: str) -> RoomError:
    return RoomError(code, message, 400)


class RoomService:
    def __init__(self, store: RoomStore) -> None:
        self.store = store

    def post_message(
        self,
        identity: RuntimeIdentity,
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
        identity: RuntimeIdentity,
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
        identity: RuntimeIdentity,
        room_id: str,
        message_id: str,
        outcome: str,
        evidence: str | None = None,
    ) -> Message:
        return self.store.resolve_message(identity, room_id, message_id, outcome, evidence)
