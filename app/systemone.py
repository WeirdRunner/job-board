"""Builders for System One questions (the /v1/systemone request shape): no I/O, so the in-browser board can use them."""
from __future__ import annotations

from typing import Any, Dict


def noul(instructions: Any, true: Any = None, false: Any = None) -> dict:
    q: Dict[str, Any] = {"type": "noul", "instructions": instructions}
    if true is not None or false is not None:
        q["criteria"] = {k: v for k, v in (("true", true), ("false", false)) if v is not None}
    return q


def choice(instructions: Any, criteria: Dict[str, Any]) -> dict:
    return {"type": "choice", "instructions": instructions, "criteria": criteria}


def score(instructions: Any, levels: list) -> dict:
    return {"type": "score", "instructions": instructions, "criteria": levels}
