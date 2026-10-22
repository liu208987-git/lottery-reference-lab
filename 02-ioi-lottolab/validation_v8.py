"""v8 验证兼容入口。

这个模块不尝试从随机开奖中制造未经验证的“热号”信号。它优化的是固定
5 注预算下的组合几何：

* 每一注本身仍是等概率组合；
* 不同注的前区/红球零重叠；
* 双色球 5 个蓝球互不重复；
* 大乐透 5 个后区对子互不重复，并覆盖 10 个不同后区号码。

在当前两种彩票的号码池大小下，零重叠是可行的。它能达到任一注命中
双色球 >=4 红或大乐透 >=3 前区的联合概率上界，但不会改变单注头奖概率。
"""

from v8_predictor import build_v8_balanced, portfolio_diagnostics, v8_rng, v8_seed

__all__ = ["build_v8_balanced", "portfolio_diagnostics", "v8_rng", "v8_seed"]
