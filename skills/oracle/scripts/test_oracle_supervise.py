import importlib.util
import sys
import tempfile
from pathlib import Path
from unittest import TestCase, main

MODULE_PATH = Path(__file__).with_name("oracle_supervise.py")
SPEC = importlib.util.spec_from_file_location("oracle_supervise", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class TestOracleSupervise(TestCase):
    def test_extract_answer_block_from_oracle_output(self):
        text = "Launching browser mode\nAnswer:\nThis is the answer body.\nIt has multiple lines.\n"
        self.assertEqual(MODULE.extract_answer_block(text), "This is the answer body.\nIt has multiple lines.")

    def test_substantive_text_rejects_metadata_only(self):
        metadata = "Status: running\nSession ID: abc\nModel: gpt-5.4-pro\nResponse: status=running\n"
        self.assertEqual(MODULE.substantive_text_reason(metadata), "metadata-only")

    def test_choose_delivery_candidate_prefers_valid_answer(self):
        good_answer = "This is a substantive answer. " * 30
        chosen = MODULE.choose_delivery_candidate(
            [
                ("metadata", "Status: running\nSession ID: abc\nModel: gpt-5.4-pro\n"),
                ("answer", good_answer),
            ]
        )
        assert chosen is not None
        label, text, reason = chosen
        self.assertEqual(label, "answer")
        self.assertEqual(reason, "ok")
        self.assertIn("substantive answer", text)

    def test_load_session_snapshot_marks_stale_running_when_pid_and_port_dead(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            session_root = Path(temp_dir)
            session_dir = session_root / "demo-slug"
            session_dir.mkdir()
            (session_dir / "meta.json").write_text(
                """
                {
                  "status": "running",
                  "browser": {
                    "runtime": {
                      "chromePid": 999999,
                      "chromeHost": "127.0.0.1",
                      "chromePort": 9
                    }
                  }
                }
                """,
                encoding="utf-8",
            )
            snapshot = MODULE.load_session_snapshot(session_root, "demo-slug")
            self.assertTrue(snapshot.exists)
            self.assertEqual(snapshot.status, "running")
            self.assertFalse(snapshot.chrome_pid_alive)
            self.assertFalse(snapshot.chrome_port_open)
            self.assertTrue(snapshot.stale_running_suspected)


if __name__ == "__main__":
    main()
