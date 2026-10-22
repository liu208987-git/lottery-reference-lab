import unittest

from single_ticket_ensemble import current_prize, era_prize
from dlt_prediction_audit import prize_level as production_dlt_prize


def test_ssq_prize_boundaries():
    assert current_prize("ssq", 6, 1) == "一等奖"
    assert current_prize("ssq", 6, 0) == "二等奖"
    assert current_prize("ssq", 3, 1) == "五等奖"
    assert current_prize("ssq", 3, 0) is None
    assert current_prize("ssq", 0, 1) == "六等奖"


def test_dlt_current_seven_level_mapping():
    assert current_prize("dlt", 5, 2) == "一等奖"
    assert current_prize("dlt", 4, 2) == "三等奖"
    assert current_prize("dlt", 3, 2) == "五等奖"
    assert current_prize("dlt", 2, 2) == "六等奖"
    assert current_prize("dlt", 0, 2) == "七等奖"
    assert production_dlt_prize(4, 2) == "三等奖"
    assert production_dlt_prize(3, 2) == "五等奖"
    assert production_dlt_prize(0, 2) == "七等奖"


def test_dlt_era_mapping():
    assert era_prize("dlt", "2018010", 3, 0) is None
    assert era_prize("dlt", "2019019", 3, 0) == "九等奖"
    assert era_prize("dlt", "2026014", 4, 2) == "三等奖"
    assert production_dlt_prize(3, 0, "2018010") is None
    assert production_dlt_prize(3, 0, "2019019") == "九等奖"
    assert production_dlt_prize(4, 2, "2026014") == "三等奖"


class SingleTicketEnsembleTests(unittest.TestCase):
    def test_ssq_prize_boundaries(self):
        test_ssq_prize_boundaries()

    def test_dlt_current_seven_level_mapping(self):
        test_dlt_current_seven_level_mapping()

    def test_dlt_era_mapping(self):
        test_dlt_era_mapping()
