import unittest
from unittest import mock

from marketlens import analysis, news

CASES = [
    ("RBI keeps repo rate unchanged at 5.5% - Wire", {"central_bank"}),
    ("India GDP grows 7.8% in Q1 - Wire", {"growth"}),
    ("HSBC India manufacturing PMI at 58.3 - Wire", {"pmi"}),
    ("CAD widens as oil imports jump - Wire", {"external", "trade"}),
    ("India's CAS turns to surplus on current account - Wire", {"external"}),
    ("GST collections hit record Rs 2 lakh crore - Wire", {"tax"}),
    ("Retail inflation eases to 4.2% in October - Wire", {"inflation"}),
    ("Exports rise 6% while trade deficit narrows - Wire", {"trade"}),
]
NOT_ECONOMY = ["Cad Smith joins Infosys board - Wire", "Nifty gains as banks rally - Wire", "Reliance shares jump on new launch - Wire"]


class EconomyTopics(unittest.TestCase):
    def test_headlines_map_to_topics(self):
        for title, want in CASES:
            self.assertTrue(want <= set(analysis.economy_topics(title)), (title, analysis.economy_topics(title)))

    def test_not_economy(self):
        for title in NOT_ECONOMY:
            self.assertEqual(analysis.economy_topics(title), [], title)

    def test_region_economy_keeps_only_economy_items(self):
        mk = lambda t: {"title": t, "source": "W", "link": "https://e.example/" + str(abs(hash(t))), "ts": 1}
        items = [mk("RBI cuts repo rate"), mk("Cad Smith joins board"), mk("GST collections rise")]
        news.store.cache_clear() if hasattr(news.store, "cache_clear") else None
        with mock.patch.object(news, "_gather", return_value=([items], [])), mock.patch.object(news.store, "cached", side_effect=lambda k, t, f: f()), \
                mock.patch.object(news.store, "disk_put"), mock.patch.object(news.settings, "news", True):
            out = news.region_news("economy")
        self.assertEqual([i["title"] for i in out["items"]], ["RBI cuts repo rate", "GST collections rise"])
        self.assertTrue(all(i["topics"] for i in out["items"]))


if __name__ == "__main__":
    unittest.main()
