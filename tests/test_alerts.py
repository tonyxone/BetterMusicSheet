import unittest
from pathlib import Path
import tempfile

import alerts

DURATION = "Recognized duration differs from the time signature; playback timing is inferred."
FERMATA = "Fermatas use a 50% hold; adjust the BPM or note correction for a different interpretation."


def timeline(problem=0, informational=0, total=20, **stats):
    measures = [{"warnings": [DURATION]} for _ in range(problem)]
    measures += [{"warnings": [FERMATA]} for _ in range(informational)]
    measures += [{"warnings": []} for _ in range(total - len(measures))]
    return {"measures": measures, "stats": stats, "warnings": []}


class TimelineQualityTests(unittest.TestCase):
    def test_a_clean_sheet_has_no_reasons(self):
        quality = alerts.timeline_quality(timeline(problem=2, notes_matched=500, notes_unmatched=3))
        self.assertEqual(quality["reasons"], [])
        self.assertEqual(quality["problem_measures"], 2)

    def test_many_problem_measures_is_rough(self):
        quality = alerts.timeline_quality(timeline(problem=6))
        self.assertEqual(quality["reasons"], ["6 of 20 measures have recognition warnings"])
        self.assertEqual(quality["top_warnings"], [(DURATION, 6)])

    def test_informational_warnings_do_not_count(self):
        self.assertEqual(alerts.timeline_quality(timeline(informational=20))["reasons"], [])

    def test_a_short_piece_needs_several_problem_measures(self):
        self.assertEqual(alerts.timeline_quality(timeline(problem=4, total=4))["reasons"], [])

    def test_unmatched_notes_and_missing_pages_are_rough(self):
        quality = alerts.timeline_quality(timeline(notes_matched=90, notes_unmatched=10, pages_without_regions=1))
        self.assertEqual(quality["reasons"], ["10 of 100 notes could not be matched to the printed page",
                                              "1 page(s) have no recognized measures"])

    def test_a_missing_or_unreadable_timeline(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = alerts.assess(Path(directory) / "timeline.json")
            self.assertIn("No playback timeline", missing["reasons"][0])
            broken = Path(directory) / "broken.json"
            broken.write_text("{")
            self.assertIsNone(alerts.assess(broken))


if __name__ == "__main__":
    unittest.main()
