import csv
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

import duckdb

from common import PROCESSED, connect


failures = 0


def check(label, fn):
    global failures
    try:
        detail = fn()
        print(f"OK {label}: {detail}")
    except Exception as exc:
        failures += 1
        print(f"FALLO {label}: {exc}")


def rows(path):
    with path.open(newline="") as file:
        return list(csv.DictReader(file))


def close(actual, expected, tolerance):
    assert abs(actual - expected) <= tolerance, f"{actual} vs {expected} ± {tolerance}"


def conservation(region):
    con = connect(region)
    raw = dict(con.execute("""
        SELECT satellite, count(*) FROM m GROUP BY satellite
    """).fetchall())
    raw["SNPP"] = con.execute("SELECT count(*) FROM v").fetchone()[0]
    path = PROCESSED / region / "cell_day.parquet"
    actual = dict(con.execute("SELECT sensor, sum(n_det) FROM read_parquet(?) GROUP BY sensor", [str(path)]).fetchall())
    assert actual == raw, f"aggregate={actual}; raw={raw}"
    if region == "mx":
        assert raw["Terra"] + raw["Aqua"] == 1_685_470, raw
        assert raw["SNPP"] == 4_225_823, raw
    con.close()
    return str(actual)


def lst(region):
    expected = {"mx": {"Aqua": 14.39, "Terra": 9.66, "N": 13.27},
                "us": {"Aqua": 14.20, "Terra": 9.89}}[region]
    data = {(r["satellite"], int(r["year"])): float(r["lst_median"])
            for r in rows(PROCESSED / region / "lst_by_year.csv")}
    for sensor, value in expected.items():
        close(data[sensor, 2025], value, 0.05)
    return str({k: data[k, 2025] for k in expected})


def ratios(region):
    expected = {"mx": [(2025, "terra_snpp", 0.143), (2021, "terra_snpp", 0.168),
                       (2024, "aqua_snpp", 0.260)],
                "us": [(2025, "terra_snpp", 0.227), (2021, "terra_snpp", 0.308)]}[region]
    data = {(int(r["year"]), r["daynight"]): r
            for r in rows(PROCESSED / region / "ratio_by_year.csv")}
    observed = {}
    for year, column, value in expected:
        actual = float(data[year, "D"][column])
        close(actual, value, 0.003)
        observed[f"{year} {column}"] = round(actual, 4)
    return str(observed)


def overlap():
    data = {(r["daynight"], r["bin"]): r for r in rows(PROCESSED / "mx" / "overlap_probability.csv")}
    expected = [("D", "p_mismo_dia", 0.323), ("D", "p_dia_siguiente", 0.072),
                ("N", "p_mismo_dia", 0.449), ("N", "p_dia_siguiente", 0.197)]
    observed = {}
    for daynight, column, value in expected:
        actual = float(data[daynight, "30+"][column])
        close(actual, value, 0.003)
        observed[f"{daynight} {column}"] = round(actual, 4)
    return str(observed)


def versions():
    data = rows(PROCESSED / "mx" / "versions_by_year.csv")
    observed = {}
    for year in (2022, 2023):
        observed[year] = sorted({r["version"] for r in data
                                 if r["satellite"] in ("Terra", "Aqua") and int(r["year"]) == year})
    assert observed[2022] != observed[2023], observed
    return str(observed)


def monthly_conservation(region):
    con = duckdb.connect()
    folder = PROCESSED / region
    daily = con.execute("SELECT sum(n_det), sum(n_det * 0 + 1) FROM read_parquet(?)", [str(folder / "cell_day.parquet")]).fetchone()
    monthly = con.execute("SELECT sum(n_det), sum(n_cell_days) FROM read_parquet(?)", [str(folder / "month_cell025.parquet")]).fetchone()
    assert daily == monthly, f"cell_day={daily}, month_cell025={monthly}"
    return f"n_det={daily[0]}, cell_days={daily[1]}"


for region in ("mx", "us"):
    check(f"conservación {region}", lambda region=region: conservation(region))
    check(f"mes vs día {region}", lambda region=region: monthly_conservation(region))
    check(f"LST {region}", lambda region=region: lst(region))
    check(f"razones {region}", lambda region=region: ratios(region))
check("solapamiento MX", overlap)
check("versiones MODIS", versions)
print(f"RESULTADO: {failures} fallo(s)")
sys.exit(1 if failures else 0)
