"""Tests de la lógica pura del puente (sin terminal MT5: MetaTrader5 simulado)."""
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

fake_mt5 = mock.MagicMock()
fake_mt5.DEAL_TYPE_BUY, fake_mt5.DEAL_TYPE_SELL = 0, 1
fake_mt5.DEAL_ENTRY_IN, fake_mt5.DEAL_ENTRY_OUT, fake_mt5.DEAL_ENTRY_OUT_BY = 0, 1, 3
sys.modules.setdefault("MetaTrader5", fake_mt5)

import bridge  # noqa: E402


class EstimateOffsetTest(unittest.TestCase):
    def test_servidor_en_utc(self):
        self.assertEqual(bridge.estimate_offset(1_000_030, 1_000_000), 0)

    def test_servidor_utc_mas_3(self):
        self.assertEqual(bridge.estimate_offset(1_000_000 + 3 * 3600 - 20, 1_000_000), 3 * 3600)

    def test_tick_viejo_no_sirve(self):
        self.assertIsNone(bridge.estimate_offset(1_000_000 - 900, 1_000_000))


class DealToDictTest(unittest.TestCase):
    def test_hora_en_utc_y_lado(self):
        d = SimpleNamespace(ticket=1, position_id=7, symbol="XAUUSDm", type=1, entry=1, volume=0.07,
                            price=4178.9, profit=117.8, commission=-0.5, swap=0.0, fee=0.0,
                            time=10_000 + 7200, magic=260901, comment="[tp 4178.900]")
        out = bridge.deal_to_dict(d, 7200)
        self.assertEqual(out["time"], 10_000)
        self.assertEqual((out["type"], out["entry"], out["position"]), ("SELL", "out", 7))
        self.assertEqual(out["commission"], -0.5)


class OpeningLevelsTest(unittest.TestCase):
    def test_sl_tp_de_la_orden_de_apertura(self):
        orders = (SimpleNamespace(time_setup=20, sl=0.0, tp=0.0), SimpleNamespace(time_setup=10, sl=85001.08, tp=84365.85))
        with mock.patch.object(bridge.mt5, "history_orders_get", return_value=orders):
            self.assertEqual(bridge.opening_levels(7), {"sl": 85001.08, "tp": 84365.85})
        with mock.patch.object(bridge.mt5, "history_orders_get", return_value=None):
            self.assertEqual(bridge.opening_levels(7), {"sl": None, "tp": None})


class RatesTest(unittest.TestCase):
    def test_vela_en_utc(self):
        r = {"time": 10_000 + 7200, "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "tick_volume": 42}
        self.assertEqual(bridge.rate_to_dict(r, 7200),
                         {"time": 10_000, "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 42})

    def test_peticion_valida(self):
        self.assertEqual(bridge.parse_rates_request({"symbol": "US30m", "timeframe": "h1", "count": 50}),
                         ("US30m", "H1", 50, None))
        self.assertEqual(bridge.parse_rates_request({"symbol": "US30m", "to": "1790896500"})[3], 1790896500)

    def test_peticion_invalida(self):
        for payload in ({}, {"symbol": "US30m", "timeframe": "D7"}, {"symbol": "US30m", "count": 0},
                        {"symbol": "US30m", "count": "x"}):
            with self.assertRaises(bridge.BridgeError):
                bridge.parse_rates_request(payload)

    def test_market_rates_corrige_hora_servidor(self):
        rates = [{"time": 3600 + 300, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "tick_volume": 3}]
        info = SimpleNamespace(digits=1)
        tick = SimpleNamespace(bid=51008.3, ask=51009.6, time=3600 + 400)
        with mock.patch.object(bridge, "ensure_connected"), \
                mock.patch.object(bridge, "symbol_quote", return_value=(info, tick)), \
                mock.patch.object(bridge, "server_offset", return_value=(3600, "tick")), \
                mock.patch.object(bridge.mt5, "copy_rates_from_pos", return_value=rates):
            out = bridge.market_rates({"symbol": "US30m"})
        self.assertEqual((out["bid"], out["ask"], out["tickTime"]), (51008.3, 51009.6, 400))
        self.assertEqual(out["rates"][0]["time"], 300)


if __name__ == "__main__":
    unittest.main()
