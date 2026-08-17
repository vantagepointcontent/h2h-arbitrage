import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("audit-bot-propositions.py")
KNOWN_CONDITION = "0xe25b0be3d538078068d0bf2fd311bfbda4b07be31bee8ac4cdf1a0999d2bf328"
KNOWN_TOKEN = "68490275142290425531406410186500399331308254159595156607764183181531392837189"


class AuditBotPropositionsTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "audit.db"
        self.output_path = Path(self.temp_dir.name) / "manifest.json"
        connection = sqlite3.connect(self.db_path)
        connection.executescript("""
            CREATE TABLE executions (
              id INTEGER PRIMARY KEY, timestamp TEXT, arb_id TEXT, market_title TEXT,
              dry_run INTEGER, success INTEGER, strategy TEXT, kalshi_order TEXT,
              polymarket_order TEXT, result TEXT, estimated_profit REAL, steps TEXT,
              source TEXT, selection_method TEXT, bot_entry_evidence TEXT
            );
            CREATE TABLE bot_positions (
              id INTEGER PRIMARY KEY, execution_id INTEGER, status TEXT, opened_at TEXT,
              market_id TEXT, market_title TEXT, kalshi_ticker TEXT, pm_condition_id TEXT,
              strategy TEXT, kalshi_side TEXT, pm_side TEXT, buy_price_kalshi INTEGER,
              buy_price_pm INTEGER, pm_entry_token_id TEXT, shares_kalshi INTEGER,
              shares_pm INTEGER, total_cost INTEGER, expected_payout INTEGER,
              expected_profit INTEGER, fees INTEGER, expected_roi_bps INTEGER,
              execution_mode TEXT, entry_record_source TEXT, entry_recorded_at TEXT
            );
        """)
        self.connection = connection

    def tearDown(self):
        self.connection.close()
        self.temp_dir.cleanup()

    def run_audit(self):
        self.connection.commit()
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), str(self.db_path), str(self.output_path)],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertTrue(completed.stdout.strip())
        return json.loads(self.output_path.read_text())

    def insert_position(self, position_id, execution_id, strategy, *, known=False):
        ticker = "KXHOUSERACE-FL26-26-D" if known else "KXLEGACY-YES"
        condition = KNOWN_CONDITION if known else "0xlegacy"
        kalshi_order = {
            "platform": "kalshi", "marketId": ticker, "ticker": ticker,
            "side": "buy", "outcome": "yes", "contracts": 1, "price": 0.12,
        }
        pm_order = {
            "platform": "polymarket", "marketId": KNOWN_TOKEN if known else "legacy-token",
            "side": "buy", "outcome": "yes", "contracts": 1, "price": 0.16,
        }
        result = {
            "success": False,
            "kalshiResult": {
                "status": "cancelled", "filledContracts": 0,
                "filledPrice": 0.12112036947400938, "orderId": "dry-k",
                "timestamp": "2026-08-11T01:50:11.357Z",
            },
            "polymarketResult": {
                "status": "cancelled", "filledContracts": 1,
                "filledPrice": 0.1582813373703882, "orderId": "dry-p",
                "timestamp": "2026-08-11T01:50:13.367Z",
            },
            "rollbackExecuted": True,
            "unhedged": False,
            "executionTimeMs": 2010,
        }
        steps = [{
            "timestamp": "2026-08-11T01:50:11.357Z",
            "status": "success",
            "description": "Last scan time",
            "metadata": {"scanTime": "2026-08-11T01:50:11.355Z"},
        }]
        self.connection.execute(
            "INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (execution_id, "2026-08-11T01:50:13.376Z", f"bot:pair:{execution_id}",
             "FL-26 House Election Winner", 1, 0, strategy, json.dumps(kalshi_order),
             json.dumps(pm_order), json.dumps(result), 7.5, json.dumps(steps), "bot", None, None),
        )
        self.connection.execute(
            "INSERT INTO bot_positions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (position_id, execution_id, "open", "2026-08-11T01:50:13.377Z", "pair",
             "FL-26 House Election Winner", ticker, condition, strategy, "yes", "yes", 12, 16,
             None, 1, 1, 97, 100, 3, 69, 1071, "paper", "persisted_position",
             "2026-08-11T01:50:13.377Z"),
        )

    def test_strategy_text_alone_never_proves_same_direction_exposure(self):
        self.insert_position(1, 1, "same-platform YES+YES display label")

        manifest = self.run_audit()

        self.assertEqual(manifest["entries"][0]["classification"], "unresolved_legacy")
        self.assertEqual(manifest["counts"]["confirmed_invalid"], 0)

    def test_trade_128_distinguishes_invalid_mapping_from_executable_exposure(self):
        self.insert_position(97, 128, "Buy YES both sides: Kalshi Democratic + PM Republican", known=True)

        manifest = self.run_audit()
        entry = manifest["entries"][0]

        self.assertEqual(entry["classification"], "confirmed_invalid")
        self.assertNotEqual(entry["severity"], "high")
        self.assertEqual(manifest["counts"]["openHighSeverity"], 0)
        self.assertEqual(entry["executionEnvelope"]["mode"], "paper")
        self.assertFalse(entry["executionEnvelope"]["success"])
        self.assertEqual(entry["executionEnvelope"]["venueResults"]["kalshi"]["filledContracts"], 0)
        self.assertEqual(entry["executionEnvelope"]["venueResults"]["polymarket"]["filledContracts"], 1)
        self.assertTrue(entry["executionEnvelope"]["rollback"]["executed"])
        self.assertEqual(entry["actualExposure"]["state"], "no_executable_exposure")
        self.assertEqual(entry["calculationEnvelope"]["persistedPosition"]["totalCostCents"], 97)
        self.assertEqual(entry["evidence"]["polymarket"]["tokenId"], KNOWN_TOKEN)


if __name__ == "__main__":
    unittest.main()
