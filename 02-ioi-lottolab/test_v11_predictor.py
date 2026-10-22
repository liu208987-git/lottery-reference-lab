import unittest
from v11_predictor import build_v11_extreme,v11_rng

class V11Tests(unittest.TestCase):
    def test_every_prefix_reaches_upper_bound(self):
        tickets,meta=build_v11_extreme(v11_rng("2026080"),ticket_count=100,return_metadata=True)
        self.assertEqual(len(tickets),100);self.assertLessEqual(meta["max_red_overlap"],3)
        self.assertTrue(meta["upper_bound_achieved_for_every_prefix"])
        self.assertAlmostEqual(meta["prefixes"]["100"]["third_plus_probability"],0.0010044529997255247)

if __name__=="__main__":unittest.main()
