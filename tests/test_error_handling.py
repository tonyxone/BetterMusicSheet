"""server.py's catch-all exception handler (json_errors) must never leak a
server-log-flavored message to the browser - whatever throws, the visitor
gets one plain sentence, and the real traceback still goes to the log."""
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import server


class UnhandledErrorMessageTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app, raise_server_exceptions=False)

    def tearDown(self):
        self.client.close()

    def test_an_unhandled_exception_reaches_the_browser_as_one_plain_sentence(self):
        with patch.object(server.db, "list_annotation_jobs", side_effect=RuntimeError("boom")):
            response = self.client.get("/api/sheets")
        self.assertEqual(response.status_code, 500)
        detail = response.json()["detail"]
        self.assertNotIn("boom", detail)
        self.assertNotIn("Traceback", detail)
        self.assertNotIn("server log", detail)
        self.assertIn("try again", detail)

    def test_the_error_response_still_carries_cors_headers(self):
        # The whole reason this middleware exists (see its docstring):
        # Starlette's own unhandled-error response skips the CORS middleware
        # entirely, and the browser reports a bare "Failed to fetch" instead
        # of showing the detail at all.
        with patch.object(server.db, "list_annotation_jobs", side_effect=RuntimeError("boom")):
            response = self.client.get("/api/sheets", headers={"Origin": "http://localhost:3000"})
        self.assertIn("access-control-allow-origin", response.headers)


if __name__ == "__main__":
    unittest.main()
