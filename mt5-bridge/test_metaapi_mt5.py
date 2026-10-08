"""Tests de metaapi_mt5 (MetaApi simulado) y del puente con MT5_BACKEND=metaapi."""
import importlib.util
import os
import pathlib
import unittest
from unittest import mock

os.environ.setdefault("METAAPI_TOKEN", "test-token")
os.environ.setdefault("METAAPI_ACCOUNT_ID", "acc-1")

import metaapi_mt5 as m  # noqa: E402

SPEC = {"symbol": "XAUUSDm", "tickSize": 0.001, "point": 0.001, "digits": 3, "minVolume": 0.01,
        "maxVolume": 200, "volumeStep": 0.01, "contractSize": 100, "stopsLevel": 0,
        "fillingModes": ["SYMBOL_FILLING_FOK", "SYMBOL_FILLING_IOC"],
        "allowedExpirationModes": ["SYMBOL_EXPIRATION_GTC", "SYMBOL_EXPIRATION_SPECIFIED"],
        "tradeMode": "SYMBOL_TRADE_MODE_FULL", "description": "Gold"}
PRICE = {"symbol": "XAUUSDm", "bid": 4000.0, "ask": 4000.2, "profitTickValue": 0.1, "lossTickValue": 0.1,
         "time": "2026-10-08T15:00:00.000Z"}
ACCOUNT = {"login": 123, "server": "Exness-MT5Trial", "currency": "USD", "balance": 1000.0, "equity": 1000.0,
           "freeMargin": 950.0, "tradeAllowed": True, "type": "ACCOUNT_TRADE_MODE_DEMO"}


def fake_api(routes):
    """_request simulado: la primera ruta cuyo fragmento aparezca en la URL decide la respuesta."""
    calls = []

    def _request(method, url, body=None, missing_ok=False):
        calls.append((method, url, body))
        for fragment, response in routes.items():
            if fragment in url:
                return response(body) if callable(response) else response
        return None if missing_ok else m._FAIL

    return _request, calls


class Base(unittest.TestCase):
    def setUp(self):
        m._cache.clear()


class CuentaTest(Base):
    def test_demo_y_real(self):
        req, _ = fake_api({"/account-information": ACCOUNT})
        with mock.patch.object(m, "_request", req):
            acc = m.account_info()
        self.assertEqual((acc.login, acc.trade_mode, acc.margin_free), (123, m.ACCOUNT_TRADE_MODE_DEMO, 950.0))
        m._cache.clear()
        req, _ = fake_api({"/account-information": {**ACCOUNT, "type": "ACCOUNT_TRADE_MODE_REAL"}})
        with mock.patch.object(m, "_request", req):
            self.assertEqual(m.account_info().trade_mode, m.ACCOUNT_TRADE_MODE_REAL)

    def test_sin_conexion_devuelve_none(self):
        req, _ = fake_api({})
        with mock.patch.object(m, "_request", req):
            self.assertIsNone(m.terminal_info())


class SimboloTest(Base):
    def test_mascaras_y_tick(self):
        req, _ = fake_api({"/specification": SPEC, "/current-price": PRICE})
        with mock.patch.object(m, "_request", req):
            info = m.symbol_info("XAUUSDm")
            tick = m.symbol_info_tick("XAUUSDm")
        self.assertEqual((info.filling_mode, info.expiration_mode, info.trade_mode), (3, 5, m.SYMBOL_TRADE_MODE_FULL))
        self.assertEqual((info.volume_step, info.trade_tick_value_loss), (0.01, 0.1))
        self.assertEqual((tick.ask, tick.time), (4000.2, 1791471600))

    def test_simbolo_inexistente(self):
        req, _ = fake_api({})
        with mock.patch.object(m, "_request", req):
            self.assertFalse(m.symbol_select("NOPE"))

    def test_perdida_por_lote(self):
        req, _ = fake_api({"/specification": SPEC, "/current-price": PRICE})
        with mock.patch.object(m, "_request", req):
            # 10 $ de precio en contra = 10 000 ticks × 0.1 = −1000 por lote
            self.assertAlmostEqual(m.order_calc_profit(m.ORDER_TYPE_BUY, "XAUUSDm", 1.0, 4000.0, 3990.0), -1000.0)
            self.assertAlmostEqual(m.order_calc_profit(m.ORDER_TYPE_SELL, "XAUUSDm", 0.5, 4000.0, 4010.0), -500.0)


class EnvioTest(Base):
    def test_cuerpo_a_mercado(self):
        body = m._trade_body({"action": m.TRADE_ACTION_DEAL, "type": m.ORDER_TYPE_SELL, "symbol": "XAUUSDm",
                              "volume": 0.05, "price": 4000.0, "sl": 4010.0, "tp": 3980.0, "magic": 260901,
                              "comment": "FS h1234567890123456789012345", "deviation": 20,
                              "type_filling": m.ORDER_FILLING_IOC})
        self.assertEqual(body["actionType"], "ORDER_TYPE_SELL")
        self.assertEqual((body["stopLoss"], body["takeProfit"], body["slippage"]), (4010.0, 3980.0, 20))
        self.assertEqual(body["fillingModes"], ["ORDER_FILLING_IOC"])
        self.assertLessEqual(len(body["comment"]), 26)
        self.assertNotIn("openPrice", body)

    def test_cuerpo_pendiente_con_caducidad(self):
        body = m._trade_body({"action": m.TRADE_ACTION_PENDING, "type": m.ORDER_TYPE_BUY_LIMIT, "symbol": "XAUUSDm",
                              "volume": 0.05, "price": 3990.0, "sl": 3980.0, "tp": 0.0,
                              "type_time": m.ORDER_TIME_SPECIFIED, "expiration": 1791471600})
        self.assertEqual((body["actionType"], body["openPrice"]), ("ORDER_TYPE_BUY_LIMIT", 3990.0))
        self.assertEqual(body["expiration"], {"type": "ORDER_TIME_SPECIFIED", "time": "2026-10-08T15:00:00.000Z"})
        self.assertNotIn("takeProfit", body)

    def test_resultado_como_mt5(self):
        req, _ = fake_api({"/trade": {"numericCode": 10009, "stringCode": "TRADE_RETCODE_DONE",
                                      "message": "Request completed", "orderId": "47137555"}})
        with mock.patch.object(m, "_request", req):
            res = m.order_send({"action": m.TRADE_ACTION_DEAL, "type": m.ORDER_TYPE_BUY, "symbol": "X", "volume": 1})
        self.assertEqual((res.retcode, res.order, res.comment), (m.TRADE_RETCODE_DONE, 47137555, "Request completed"))


class HistorialTest(Base):
    def test_deals_mapeados(self):
        deal = {"id": "33582357", "type": "DEAL_TYPE_SELL", "entryType": "DEAL_ENTRY_OUT", "symbol": "XAUUSDm",
                "magic": 260901, "time": "2026-10-08T15:00:00.000Z", "volume": 0.05, "price": 3980.0,
                "profit": 100.0, "commission": -0.2, "swap": 0, "positionId": "46648037", "reason": "DEAL_REASON_TP"}
        req, calls = fake_api({"/history-deals/": [deal]})
        with mock.patch.object(m, "_request", req):
            d = m.history_deals_get(1791460000, 1791480000)[0]
        self.assertIn("/history-deals/time/2026-10-08T", calls[0][1])
        self.assertEqual((d.type, d.entry, d.reason, d.position_id), (m.DEAL_TYPE_SELL, m.DEAL_ENTRY_OUT,
                                                                       m.DEAL_REASON_TP, 46648037))
        self.assertEqual(d.time, 1791471600)

    def test_ordenes_filtradas_por_ticket(self):
        orders = [{"id": "1", "symbol": "A", "time": "2026-10-08T15:00:00Z", "state": "ORDER_STATE_PLACED"},
                  {"id": "2", "symbol": "B", "time": "2026-10-08T15:00:00Z", "state": "ORDER_STATE_PLACED"}]
        req, _ = fake_api({"/orders": orders})
        with mock.patch.object(m, "_request", req):
            self.assertEqual([o.symbol for o in m.orders_get(ticket=2)], ["B"])
            self.assertEqual(len(m.orders_get()), 2)


class VelasTest(Base):
    def test_ordenadas_y_paginadas(self):
        def candle(minute):
            return {"time": f"2026-10-08T15:{minute:02d}:00.000Z", "open": 1, "high": 2, "low": 0.5, "close": 1.5,
                    "tickVolume": minute}

        pages = [[candle(10), candle(5)], [candle(0)]]
        with mock.patch.object(m, "MAX_CANDLES_PER_CALL", 2), \
                mock.patch.object(m, "_get", side_effect=pages):
            rates = m.copy_rates_from_pos("X", m.TIMEFRAME_M5, 0, 3)
        self.assertEqual([r["tick_volume"] for r in rates], [0, 5, 10])
        self.assertEqual(rates[0]["time"], 1791471600)


class PuenteConMetaApiTest(Base):
    """bridge.py real con MT5_BACKEND=metaapi: vista previa de una orden de señal."""

    @classmethod
    def setUpClass(cls):
        path = pathlib.Path(__file__).with_name("bridge.py")
        spec = importlib.util.spec_from_file_location("bridge_metaapi", path)
        with mock.patch.dict(os.environ, {"MT5_BACKEND": "metaapi"}):
            cls.bridge = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.bridge)

    def test_backend_es_metaapi(self):
        self.assertIs(self.bridge.mt5, m)

    def test_vista_previa_limit_por_riesgo(self):
        req, calls = fake_api({"/account-information": ACCOUNT, "/specification": SPEC, "/current-price": PRICE,
                               "/calculate-margin": {"margin": 50.0}})
        payload = {"symbol": "XAUUSDm", "side": "LONG", "entry": 3995.0, "sl": 3985.0, "tp": 4015.0,
                   "risk_pct": 1, "dry_run": True}
        with mock.patch.object(m, "_request", req):
            out = self.bridge.place_signal(payload, "XAUUSDm", "LONG")
        # ask 4000.2 > entrada 3995 → LIMIT; 1 % de 1000 $ / 1000 $ por lote → 0.01 lotes
        self.assertEqual((out["mode"], out["volume"], out["price"]), ("pending", 0.01, 3995.0))
        self.assertTrue(out["dryRun"])
        self.assertFalse(any("/trade" in url for _, url, _ in calls))


if __name__ == "__main__":
    unittest.main()
