import math
import unittest

import numpy as np

from ssq_blue_joint_backtest import (
    FeatureStore,
    _posthoc_any_hot_probability,
)


def _synthetic_draw(index: int) -> dict:
    reds = sorted({((index + step * 5) % 33) + 1 for step in range(6)})
    while len(reds) < 6:
        candidate = ((reds[-1] + 7) % 33) + 1
        reds = sorted(set(reds + [candidate]))
    row = {"issue": f"T{index:04d}", "b1": (index % 16) + 1}
    for position, value in enumerate(reds, 1):
        row[f"r{position}"] = value
    return row


class BlueJointBacktestTests(unittest.TestCase):
    def test_posthoc_probability_is_exact_and_plausible(self):
        probability = _posthoc_any_hot_probability(15, 16, 4)
        self.assertAlmostEqual(probability, 0.18476746843815084, places=12)

    def test_future_changes_cannot_change_target_probability(self):
        draws = [_synthetic_draw(i) for i in range(620)]
        original = FeatureStore.build(draws)
        p_before = original.probabilities(
            550, 200, "joint_opportunity_normalized")

        changed = [dict(row) for row in draws]
        for i in range(550, len(changed)):
            changed[i]["b1"] = ((i * 7) % 16) + 1
            for position in range(1, 7):
                changed[i][f"r{position}"] = position + 20
        modified = FeatureStore.build(changed)
        p_after = modified.probabilities(
            550, 200, "joint_opportunity_normalized")

        np.testing.assert_allclose(p_before, p_after, atol=0, rtol=0)
        self.assertAlmostEqual(float(p_before.sum()), 1.0, places=12)
        self.assertTrue(all(math.isfinite(float(value)) for value in p_before))


if __name__ == "__main__":
    unittest.main()
