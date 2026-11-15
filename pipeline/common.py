from pathlib import Path

import duckdb


ROOT = Path(__file__).resolve().parents[1]
RAW = {
    "mx": (ROOT / "data/raw", "Mexico", "2012-01-20"),
    "us": (ROOT / "data/raw_us", "United_States", "2018-01-01"),
}
PROCESSED = ROOT / "data/processed"


def connect(region):
    if region not in RAW:
        raise ValueError(f"Unknown region: {region}")
    base, country, _ = RAW[region]
    con = duckdb.connect()
    for view, folder, prefix in (("m", "modis", "modis"), ("v", "viirs-snpp", "viirs-snpp")):
        pattern = base / folder / f"{prefix}_*_{country}.csv"
        con.execute(
            f"CREATE VIEW {view} AS SELECT * FROM read_csv('{pattern}', "
            "types={'acq_time':'VARCHAR','confidence':'VARCHAR'}, union_by_name=true)"
        )
    return con
