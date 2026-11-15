from pathlib import Path

import duckdb


ROOT = Path(__file__).resolve().parents[1]
RAW = {
    "mx": (ROOT / "data/raw", "Mexico", "2012-01-20"),
    "us": (ROOT / "data/raw_us", "United_States", "2018-01-01"),
}
PROCESSED = ROOT / "data/processed"
# 2026 todavía no tiene CSV anual por país: sale de la API de área (scripts/download_firms_2026.py)
# y pipeline/prepare_2026.py lo deja con las columnas de los CSV anuales, solo México y meses completos.
RAW_2026 = ROOT / "data/raw/2026_api"


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


def connect_2026(con):
    """Vistas m26 y v26 con los puntos de 2026 ya preparados; False si no se han bajado."""
    files = {"m26": RAW_2026 / "mexico/modis_2026_Mexico.csv", "v26": RAW_2026 / "mexico/viirs-snpp_2026_Mexico.csv"}
    if not all(path.exists() for path in files.values()):
        return False
    for view, path in files.items():
        con.execute(
            f"CREATE VIEW {view} AS SELECT * FROM read_csv('{path}', "
            "types={'acq_time':'VARCHAR','confidence':'VARCHAR','version':'VARCHAR'})"
        )
    return True
