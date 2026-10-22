"""生成并锁定双色球v11的100注排序实验预测。"""
from __future__ import annotations
import ssq_db
from ssq_prediction_audit import next_issue,record_prediction
from v11_predictor import ALGORITHM_NAME,build_v11_extreme,v11_rng

def main():
    rows=ssq_db.get_all_draws("ASC");trained=str(rows[-1]["issue"]);target=next_issue(trained)
    tickets,meta=build_v11_extreme(v11_rng(target),rows,100,rank_current=True,return_metadata=True)
    inserted=record_prediction(target,ALGORITHM_NAME,trained,tickets,
        model_info={**meta,"status":"experimental_not_production","backtest_report":"v11_backtest_report.md"},
        provenance="prospective_locked_experimental")
    print(f"v11 {target}：100注已按次级指数排序；前50注投入100元，前100注投入200元")
    print("预测已锁定。" if inserted else "本期v11已锁定，未覆盖。")

if __name__=="__main__":main()
