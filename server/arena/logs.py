"""Logging setup. Events are logged as a short name plus fields passed through `extra`,
e.g. `log.info("match_started", extra={"room": code})`. Never log player tokens.
"""

import json
import logging
import time
from typing import Any

# Attributes every log record has; anything else on a record came from `extra`.
_STANDARD = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime", "color_message"}


class Formatter(logging.Formatter):
    """One line per record: JSON for machines, or `key=value` text for people."""

    def __init__(self, as_json: bool = False) -> None:
        super().__init__()
        self.as_json = as_json

    def format(self, record: logging.LogRecord) -> str:
        fields = {key: value for key, value in record.__dict__.items() if key not in _STANDARD}
        message = record.getMessage()
        if record.exc_info:
            fields["exception"] = self.formatException(record.exc_info)
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
        if self.as_json:
            entry: dict[str, Any] = {
                "ts": f"{stamp}.{int(record.msecs):03d}Z",
                "level": record.levelname.lower(),
                "logger": record.name,
                "msg": message,
                **fields,
            }
            return json.dumps(entry, ensure_ascii=False, default=str)
        exception = fields.pop("exception", None)
        text = " ".join([message, *(f"{key}={value}" for key, value in fields.items())])
        line = f"{stamp} {record.levelname:<7} {record.name}: {text}"
        return f"{line}\n{exception}" if exception else line


def log_config(as_json: bool) -> dict[str, Any]:
    """Configuration for `logging.config.dictConfig`, shared by the game and by uvicorn."""
    logger = {"handlers": ["stdout"], "level": "INFO", "propagate": False}
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"arena": {"()": "arena.logs.Formatter", "as_json": as_json}},
        "handlers": {
            "stdout": {
                "class": "logging.StreamHandler",
                "formatter": "arena",
                "stream": "ext://sys.stdout",
            }
        },
        "loggers": {
            "arena": logger,
            "uvicorn": logger,
            "uvicorn.error": logger,
            "uvicorn.access": logger,
        },
    }
