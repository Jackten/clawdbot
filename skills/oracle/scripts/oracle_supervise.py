#!/usr/bin/env python3
"""Supervised Oracle wrapper for stateful browser runs.

Why this exists:
- Oracle browser runs are long-lived/stateful jobs, not simple one-shot CLI commands.
- A ChatGPT conversation may exist even when the caller disconnects before persisting the answer.
- Successful delivery requires stdout capture, session tracking, a reattach/salvage pass, and output validation.

This wrapper keeps the fix scoped to the Oracle skill instead of redesigning unrelated OpenClaw subsystems.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import select
import shlex
import signal
import socket
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


ANSWER_MARKER = "Answer:"
DEFAULT_MODEL = "gpt-5.4-pro"
DEFAULT_ENGINE = "browser"
DEFAULT_TIMEOUT_SEC = 75 * 60
DEFAULT_REATTACH_TIMEOUT_SEC = 4 * 60
MIN_SUBSTANTIVE_CHARS = 200
MIN_SUBSTANTIVE_WORDS = 40


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def slugify(value: str) -> str:
    lowered = value.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered).strip("-")
    return slug or "oracle-run"


def normalize_files(values: Iterable[str]) -> list[str]:
    normalized: list[str] = []
    for value in values:
        parts = [part.strip() for part in value.split(",")]
        normalized.extend(part for part in parts if part)
    return normalized


@dataclass
class SessionSnapshot:
    slug: str
    exists: bool
    session_dir: str
    meta_path: str
    output_log_path: str
    status: str | None = None
    error_message: str | None = None
    incomplete_reason: str | None = None
    response_status: str | None = None
    response_incomplete_reason: str | None = None
    conversation_id: str | None = None
    tab_url: str | None = None
    chrome_pid: int | None = None
    chrome_host: str | None = None
    chrome_port: int | None = None
    chrome_pid_alive: bool | None = None
    chrome_port_open: bool | None = None
    stale_running_suspected: bool = False


@dataclass
class AttemptResult:
    command: list[str]
    returncode: int | None
    timed_out: bool
    duration_sec: float
    captured_output: str


@dataclass
class DeliveryState:
    slug: str
    started_at: str
    finished_at: str | None
    mode: str
    model: str
    output_path: str
    raw_log_path: str
    state_path: str
    session_root: str
    launch_command: list[str]
    launch_returncode: int | None = None
    launch_timed_out: bool = False
    reattach_attempted: bool = False
    reattach_returncode: int | None = None
    delivery_method: str | None = None
    delivered: bool = False
    validation_reason: str | None = None
    session_snapshot: dict[str, Any] | None = None


class TeeLogger:
    def __init__(self, raw_log_path: Path, quiet: bool) -> None:
        self.raw_log_path = raw_log_path
        self.quiet = quiet
        raw_log_path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = raw_log_path.open("a", encoding="utf-8")

    def write(self, text: str, *, also_stdout: bool = True) -> None:
        if not text:
            return
        self.handle.write(text)
        self.handle.flush()
        if also_stdout and not self.quiet:
            print(text, end="")
            sys.stdout.flush()

    def section(self, title: str) -> None:
        self.write(f"\n===== {title} =====\n", also_stdout=False)

    def close(self) -> None:
        self.handle.close()


def load_session_snapshot(session_root: Path, slug: str) -> SessionSnapshot:
    session_dir = session_root / slug
    meta_path = session_dir / "meta.json"
    output_log_path = session_dir / "output.log"
    snapshot = SessionSnapshot(
        slug=slug,
        exists=session_dir.exists(),
        session_dir=str(session_dir),
        meta_path=str(meta_path),
        output_log_path=str(output_log_path),
    )
    if not meta_path.exists():
        return snapshot

    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return snapshot

    snapshot.status = stringify(meta.get("status"))
    snapshot.error_message = stringify(meta.get("errorMessage"))
    snapshot.incomplete_reason = stringify(meta.get("incompleteReason"))

    response = meta.get("response") if isinstance(meta.get("response"), dict) else {}
    browser = meta.get("browser") if isinstance(meta.get("browser"), dict) else {}
    runtime = browser.get("runtime") if isinstance(browser.get("runtime"), dict) else {}

    snapshot.response_status = stringify(response.get("status"))
    snapshot.response_incomplete_reason = stringify(response.get("incompleteReason"))
    snapshot.conversation_id = stringify(runtime.get("conversationId"))
    snapshot.tab_url = stringify(runtime.get("tabUrl"))
    snapshot.chrome_pid = runtime.get("chromePid") if isinstance(runtime.get("chromePid"), int) else None
    snapshot.chrome_host = stringify(runtime.get("chromeHost"))
    snapshot.chrome_port = runtime.get("chromePort") if isinstance(runtime.get("chromePort"), int) else None
    snapshot.chrome_pid_alive = pid_alive(snapshot.chrome_pid) if snapshot.chrome_pid is not None else None
    snapshot.chrome_port_open = (
        port_open(snapshot.chrome_host or "127.0.0.1", snapshot.chrome_port)
        if snapshot.chrome_port is not None
        else None
    )
    snapshot.stale_running_suspected = bool(
        snapshot.status == "running"
        and snapshot.chrome_pid_alive is False
        and snapshot.chrome_port_open is False
    )
    return snapshot


def stringify(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def pid_alive(pid: int | None) -> bool:
    if pid is None or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def port_open(host: str, port: int | None, timeout: float = 0.4) -> bool:
    if port is None or port <= 0:
        return False
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def extract_answer_block(text: str) -> str | None:
    if not text:
        return None
    normalized = text.replace("\r\n", "\n")
    marker_index = normalized.find(ANSWER_MARKER)
    if marker_index >= 0:
        candidate = normalized[marker_index + len(ANSWER_MARKER) :].strip()
        if candidate:
            return candidate
    return None


def strip_wrapper_noise(text: str) -> str:
    lines = []
    for line in text.replace("\r\n", "\n").split("\n"):
        stripped = line.strip()
        if stripped.startswith("Launching browser mode"):
            continue
        if stripped.startswith("This run can take up to an hour"):
            continue
        if stripped.startswith("Session ID:"):
            continue
        if stripped.startswith("Model:"):
            continue
        if stripped.startswith("Status:") and len(stripped.split()) <= 6:
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def looks_like_metadata_only(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return True
    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    if not lines:
        return True
    metadataish = 0
    for line in lines[:10]:
        lower = line.lower()
        if lower.startswith(("status:", "session id:", "model:", "response:", "created:", "updated:")):
            metadataish += 1
    return metadataish >= min(3, len(lines))


def substantive_text_reason(text: str) -> str | None:
    stripped = text.strip()
    if not stripped:
        return "empty"
    if looks_like_metadata_only(stripped):
        return "metadata-only"
    words = re.findall(r"\b\w+\b", stripped)
    letters = re.findall(r"[A-Za-z]", stripped)
    if len(stripped) < MIN_SUBSTANTIVE_CHARS:
        return f"too-short:{len(stripped)}chars"
    if len(words) < MIN_SUBSTANTIVE_WORDS:
        return f"too-short:{len(words)}words"
    if len(letters) < 120:
        return f"too-few-letters:{len(letters)}"
    return None


def read_text_if_exists(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def run_command(
    command: Sequence[str],
    logger: TeeLogger,
    timeout_sec: int,
    *,
    env: dict[str, str] | None = None,
    mirror_stdout: bool = True,
) -> AttemptResult:
    start = time.monotonic()
    logger.section("RUN " + shell_join(command))
    proc = subprocess.Popen(
        list(command),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
        env=env,
    )
    captured_parts: list[str] = []
    timed_out = False
    try:
        assert proc.stdout is not None
        fd = proc.stdout.fileno()
        while True:
            if time.monotonic() - start > timeout_sec:
                timed_out = True
                logger.write(f"\n[oracle-supervise] timeout after {timeout_sec}s; terminating process\n")
                terminate_process(proc)
                break
            ready, _, _ = select.select([fd], [], [], 0.25)
            if ready:
                chunk = os.read(fd, 4096)
                if chunk:
                    text = chunk.decode("utf-8", errors="replace")
                    captured_parts.append(text)
                    logger.write(text, also_stdout=mirror_stdout)
                    continue
            if proc.poll() is not None:
                break
        while True:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace")
            captured_parts.append(text)
            logger.write(text, also_stdout=mirror_stdout)
    finally:
        if proc.stdout is not None:
            proc.stdout.close()
    returncode = proc.wait()
    duration = time.monotonic() - start
    return AttemptResult(
        command=list(command),
        returncode=returncode,
        timed_out=timed_out,
        duration_sec=duration,
        captured_output="".join(captured_parts),
    )


def terminate_process(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    try:
        proc.send_signal(signal.SIGINT)
        proc.wait(timeout=8)
        return
    except Exception:
        pass
    try:
        proc.terminate()
        proc.wait(timeout=5)
        return
    except Exception:
        pass
    try:
        proc.kill()
    except Exception:
        return


def shell_join(parts: Sequence[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


def write_state(path: Path, state: DeliveryState) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(state), indent=2) + "\n", encoding="utf-8")


def salvage_candidates(
    *,
    slug: str,
    raw_log_text: str,
    reattach_text: str,
    session_snapshot: SessionSnapshot,
) -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []

    def add(label: str, text: str | None) -> None:
        if not text:
            return
        cleaned = strip_wrapper_noise(text)
        if cleaned:
            candidates.append((label, cleaned))

    add("reattach-answer", extract_answer_block(reattach_text))
    add("session-output-log-answer", extract_answer_block(read_text_if_exists(Path(session_snapshot.output_log_path))))
    add("launch-stdout-answer", extract_answer_block(raw_log_text))
    add("reattach-full", reattach_text if substantive_text_reason(reattach_text) is None else None)
    add("session-output-log-full", read_text_if_exists(Path(session_snapshot.output_log_path)))
    add("launch-stdout-full", raw_log_text if substantive_text_reason(raw_log_text) is None else None)
    return candidates


def choose_delivery_candidate(candidates: Iterable[tuple[str, str]]) -> tuple[str, str, str] | None:
    for label, text in candidates:
        reason = substantive_text_reason(text)
        if reason is None:
            return label, text.strip() + "\n", "ok"
    for label, text in candidates:
        reason = substantive_text_reason(text)
        if reason:
            return label, text, reason
    return None


def build_launch_command(args: argparse.Namespace) -> list[str]:
    command = [args.oracle_bin, "--engine", args.engine, "--model", args.model, "--slug", args.slug, "-p", args.prompt]
    for file_value in args.files:
        command.extend(["--file", file_value])
    if args.force:
        command.append("--force")
    command.extend(args.oracle_args)
    return command


def build_reattach_command(args: argparse.Namespace) -> list[str]:
    return [args.oracle_bin, "session", args.slug, "--render"]


def derive_defaults(args: argparse.Namespace) -> None:
    if not args.slug:
        if args.output:
            args.slug = slugify(Path(args.output).stem)
        else:
            args.slug = f"oracle-{int(time.time())}"
    if args.output and not args.raw_log:
        output_path = Path(args.output)
        args.raw_log = str(output_path.with_suffix(output_path.suffix + ".raw.log"))
    if args.output and not args.state_file:
        output_path = Path(args.output)
        args.state_file = str(output_path.with_suffix(output_path.suffix + ".oracle-job.json"))
    args.files = normalize_files(args.file or [])


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Supervise Oracle browser runs and salvage deliverable output reliably.")
    parser.add_argument("--prompt", "-p", help="Prompt to send to Oracle. Required unless --salvage-only is used.")
    parser.add_argument("--output", required=True, help="Destination file for the final answer body.")
    parser.add_argument("--slug", help="Explicit Oracle slug/session id.")
    parser.add_argument("--file", action="append", default=[], help="Oracle --file value (repeatable, commas allowed).")
    parser.add_argument("--engine", default=DEFAULT_ENGINE)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--oracle-bin", default=os.environ.get("ORACLE_BIN", "oracle"))
    parser.add_argument("--session-root", default=os.path.expanduser(os.environ.get("ORACLE_HOME_DIR", "~/.oracle/sessions")))
    parser.add_argument("--raw-log", help="Path to raw combined stdout/render log.")
    parser.add_argument("--state-file", help="Path to job state JSON.")
    parser.add_argument("--timeout-sec", type=int, default=DEFAULT_TIMEOUT_SEC)
    parser.add_argument("--reattach-timeout-sec", type=int, default=DEFAULT_REATTACH_TIMEOUT_SEC)
    parser.add_argument("--force", action="store_true", help="Pass --force to Oracle for a fresh run.")
    parser.add_argument("--salvage-only", action="store_true", help="Skip launch and attempt reattach/salvage for an existing slug.")
    parser.add_argument("--no-reattach", action="store_true", help="Do not attempt the immediate oracle session --render recovery pass.")
    parser.add_argument("--quiet", action="store_true", help="Do not mirror Oracle output to stdout; still writes raw log.")
    parser.add_argument(
        "oracle_args",
        nargs=argparse.REMAINDER,
        help="Extra arguments passed through to Oracle. Prefix with -- before extras.",
    )
    args = parser.parse_args(argv)
    derive_defaults(args)
    if not args.salvage_only and not args.prompt:
        parser.error("--prompt is required unless --salvage-only is used")
    if args.oracle_args and args.oracle_args[0] == "--":
        args.oracle_args = args.oracle_args[1:]
    return args


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    output_path = Path(args.output)
    raw_log_path = Path(args.raw_log)
    state_path = Path(args.state_file)
    session_root = Path(os.path.expanduser(args.session_root))

    ensure_parent(output_path)
    ensure_parent(raw_log_path)
    ensure_parent(state_path)

    logger = TeeLogger(raw_log_path, quiet=args.quiet)
    state = DeliveryState(
        slug=args.slug,
        started_at=utc_now(),
        finished_at=None,
        mode=args.engine,
        model=args.model,
        output_path=str(output_path),
        raw_log_path=str(raw_log_path),
        state_path=str(state_path),
        session_root=str(session_root),
        launch_command=[] if args.salvage_only else build_launch_command(args),
    )
    write_state(state_path, state)

    launch_text = ""
    reattach_text = ""
    try:
        logger.write(f"[oracle-supervise] slug={args.slug}\n")
        logger.write(f"[oracle-supervise] output={output_path}\n")
        logger.write(f"[oracle-supervise] raw_log={raw_log_path}\n")
        logger.write(f"[oracle-supervise] session_root={session_root}\n")

        if not args.salvage_only:
            launch_result = run_command(
                build_launch_command(args),
                logger,
                args.timeout_sec,
            )
            state.launch_returncode = launch_result.returncode
            state.launch_timed_out = launch_result.timed_out
            launch_text = launch_result.captured_output
            write_state(state_path, state)

        should_reattach = not args.no_reattach
        if should_reattach:
            session_before = load_session_snapshot(session_root, args.slug)
            invalid_output_reason = substantive_text_reason(read_text_if_exists(output_path))
            should_retry = (
                args.salvage_only
                or state.launch_timed_out
                or (state.launch_returncode not in (None, 0))
                or invalid_output_reason is not None
                or session_before.stale_running_suspected
                or session_before.response_incomplete_reason == "chrome-disconnected"
                or session_before.error_message is not None
            )
            if should_retry:
                state.reattach_attempted = True
                reattach_result = run_command(
                    build_reattach_command(args),
                    logger,
                    args.reattach_timeout_sec,
                )
                state.reattach_returncode = reattach_result.returncode
                reattach_text = reattach_result.captured_output
                write_state(state_path, state)

        snapshot = load_session_snapshot(session_root, args.slug)
        state.session_snapshot = asdict(snapshot)

        candidates = salvage_candidates(
            slug=args.slug,
            raw_log_text=launch_text,
            reattach_text=reattach_text,
            session_snapshot=snapshot,
        )
        chosen = choose_delivery_candidate(candidates)
        if chosen is not None:
            label, text, _ = chosen
            output_path.write_text(text, encoding="utf-8")
            state.delivery_method = label

        final_output = read_text_if_exists(output_path)
        validation_reason = substantive_text_reason(final_output)
        state.validation_reason = validation_reason or "ok"
        state.delivered = validation_reason is None
        state.finished_at = utc_now()
        write_state(state_path, state)

        if state.delivered:
            logger.write(f"[oracle-supervise] delivered via {state.delivery_method}; output verified\n")
            return 0

        if snapshot.stale_running_suspected:
            logger.write("[oracle-supervise] session metadata still says running, but browser pid+port look dead\n")
        logger.write(f"[oracle-supervise] failed delivery verification: {state.validation_reason}\n")
        return 1
    finally:
        logger.close()


if __name__ == "__main__":
    raise SystemExit(main())
