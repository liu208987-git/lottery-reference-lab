"""Synchronize complete histories and retrain both quantitative gates."""

import argparse

import dlt_db
import ssq_db
from history_sources import sync_game
from model_training import train_and_save


def run(game, full):
    db = dlt_db if game == "dlt" else ssq_db
    db.init_db()
    report = sync_game(game, db, full=full)
    state = train_and_save(game, db.get_all_draws())
    print(
        f"{game.upper()}: mode={report['mode']}, added={report['added']}, "
        f"total={report['total']}, range={report['range'][0]}-{report['range'][1]}, "
        f"conflicts={len(report['conflicts'])}, "
        f"models={state['red']['selected_model']}/{state['blue']['selected_model']}"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--game", choices=("dlt", "ssq", "all"), default="all")
    args = parser.parse_args()
    games = ("dlt", "ssq") if args.game == "all" else (args.game,)
    for game in games:
        run(game, args.full)


if __name__ == "__main__":
    main()
