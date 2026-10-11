"""The reader's settings, one set per account for every sheet: the view a
sheet opens on, the names' notation, the practice page's options. Local
(in-memory) mode, like test_demo_sheet.py."""
import unittest

from fastapi.testclient import TestClient

import auth
import db
import server

USER = "56565656-5656-4565-8565-565656565656"
OTHER = "78787878-7878-4787-8787-787878787878"


def signed_in(user_id=USER):
    return {"Authorization": f"Bearer {auth.mint_backend_token(user_id)}"}


class PreferencesTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        self.addCleanup(self.client.close)
        self.addCleanup(db.delete_user, USER)
        self.addCleanup(db.delete_user, OTHER)

    def put(self, body, user_id=USER):
        return self.client.put("/api/me/preferences", json=body, headers=signed_in(user_id))

    def test_requires_sign_in(self):
        # A guest keeps theirs in the browser; there is no account to save to.
        self.assertEqual(self.client.get("/api/me/preferences").status_code, 401)
        self.assertEqual(self.client.get("/api/me/preferences", headers={"X-Guest-Id": USER}).status_code, 401)
        self.assertEqual(self.client.put("/api/me/preferences", json={"speed": 1}).status_code, 401)

    def test_nothing_chosen_yet_is_empty(self):
        response = self.client.get("/api/me/preferences", headers=signed_in())
        self.assertEqual(response.json(), {"preferences": {}})

    def test_each_change_is_kept_alongside_the_others(self):
        self.put({"sheet_view": "original", "speed": 0.7})
        response = self.put({"show_key_names": True, "speed": 0.5})
        self.assertEqual(response.status_code, 200, response.text)
        expected = {"sheet_view": "original", "speed": 0.5, "show_key_names": True}
        self.assertEqual(response.json(), {"preferences": expected})
        self.assertEqual(self.client.get("/api/me/preferences", headers=signed_in()).json(), {"preferences": expected})

    def test_every_setting_round_trips(self):
        everything = {"sheet_view": "annotated", "notation": "solfege", "instrument": "cp80", "speed": 1.3,
                      "show_key_names": True, "show_note_names": False, "sound_on": False,
                      "sheet_open": False, "roll_open": True, "split": 0.62, "page_mode": "swipe"}
        self.assertEqual(self.put(everything).json(), {"preferences": everything})

    def test_settings_belong_to_their_own_account(self):
        self.put({"notation": "numbers"})
        self.assertEqual(self.client.get("/api/me/preferences", headers=signed_in(OTHER)).json(),
                         {"preferences": {}})

    def test_nonsense_is_refused_and_nothing_saved(self):
        for body in ({"sheet_view": "both"}, {"notation": "tab"}, {"speed": 9}, {"speed": 0},
                     {"split": 1.5}, {"instrument": "Grand Piano!"}, {"page_mode": "flip"}, {"theme": "dark"}):
            self.assertEqual(self.put(body).status_code, 422, body)
        self.assertEqual(self.client.get("/api/me/preferences", headers=signed_in()).json(), {"preferences": {}})

    def test_they_go_with_the_account(self):
        self.put({"sound_on": False})
        db.delete_user(USER)
        self.assertEqual(self.client.get("/api/me/preferences", headers=signed_in()).json(), {"preferences": {}})


if __name__ == "__main__":
    unittest.main()
