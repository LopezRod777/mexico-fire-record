import json
import hashlib
import itertools
import math
import subprocess
import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
from assign_regions import assign
from export_web_data import majority_state


failures = 0


def check(label, fn):
    global failures
    try:
        print(f"OK {label}: {fn()}")
    except Exception as exc:
        failures += 1
        print(f"FALLO {label}: {exc}")


def load(name):
    def reject(value):
        raise ValueError(f"Constante no finita: {value}")
    return json.loads((ROOT / "web/data" / name).read_text(), parse_constant=reject)


def majority_ties():
    for counts, expected in (({"MX-BCN": 4, "MX-BCS": 4, "OUT": 3}, "MX-BCN"),
                             ({"MX-BCN": 4, "OUT": 4}, "MX-BCN"),
                             ({"MX-BCN": 3, "OUT": 4}, "OUT")):
        for entries in itertools.permutations(counts.items()):
            assert majority_state(dict(entries)) == expected, entries
    return "empates estado/estado y estado/OUT; todas las permutaciones coinciden"


def export_determinism():
    paths = sorted(p for p in (ROOT / "web/data").glob("*.json") if p.name not in ("live_snapshot.json", "tle.json")) + sorted((ROOT / "web/data/geo").glob("*.geojson"))
    assert len(paths) == 7, [str(path) for path in paths]

    def hashes():
        subprocess.run([sys.executable, str(ROOT / "pipeline/export_web_data.py")],
                       cwd=ROOT, check=True, capture_output=True, text=True)
        result = {}
        for path in paths:
            if path.name == "meta.json":
                value = json.loads(path.read_text())
                value.pop("generado")
                content = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
            else:
                content = path.read_bytes()
            result[str(path.relative_to(ROOT))] = hashlib.md5(content).hexdigest()
        return result

    first, second = hashes(), hashes()
    assert first == second, [(path, first[path], second[path]) for path in first if first[path] != second[path]]
    return "2 exportaciones; 6 JSON y 1 GeoJSON idénticos por MD5 (meta sin generado)"


geo = load("geo/mx_states.geojson")
series = load("series_monthly.json")
harm = load("harmonized.json")
baseline = load("baseline_doy.json")
cells = load("cells_yearly.json")
health = load("health.json")
con = duckdb.connect()
source = str(ROOT / "data/processed/mx/cell_day.parquet")
states = str(ROOT / "data/processed/mx/cell_state.parquet")
con.execute(f"CREATE VIEW raw AS SELECT * FROM read_parquet('{source}')")
con.execute(f"CREATE VIEW state AS SELECT * FROM read_parquet('{states}')")
con.execute("""CREATE VIEW days AS SELECT DISTINCT r.sensor,r.acq_date,r.cell_i,r.cell_j,s.state_id
             FROM raw r JOIN state s USING(cell_i,cell_j)""")


def known_points():
    points = [(20.67, -103.35, "MX-JAL"), (19.43, -99.13, None),
              (25.67, -100.31, "MX-NLE"), (20.97, -89.62, "MX-YUC"),
              (32.51, -117.04, "MX-BCN"), (29.76, -95.37, "OUT"), (24., -95., "OUT")]
    actual = assign(np.array([p[0] for p in points]), np.array([p[1] for p in points]), geo["features"])
    cdmx = [f["properties"]["id"] for f in geo["features"] if "Ciudad de México" in f["properties"]["name"] or
            "Distrito Federal" in f["properties"]["name"]]
    assert len(cdmx) == 1, cdmx
    expected = [p[2] if p[2] else cdmx[0] for p in points]
    assert list(actual) == expected, f"real={list(actual)} esperado={expected}"
    return f"7 puntos; CDMX={cdmx[0]}"


def partition():
    months = series["months"]
    ids = [x for x in series["regions"] if x != "MX"]
    assert len(ids) == 32
    totals = con.execute("""SELECT sensor,strftime(acq_date,'%Y-%m') AS m,
                           sum(CASE WHEN state_id='OUT' THEN 1 ELSE 0 END),count(*)
                           FROM days GROUP BY 1,2""").fetchall()
    for sensor in series["sensors"]:
        for i, month in enumerate(months):
            national = series["regions"]["MX"][sensor][i]
            state_sum = sum(series["regions"][region][sensor][i] or 0 for region in ids)
            assert state_sum == (national or 0), (sensor, month, national, state_sum)
    for sensor, month, outside, total in totals:
        national = series["regions"]["MX"][sensor][months.index(month)]
        assert national + outside == total, (sensor, month, national, outside, total)
    union_totals = con.execute("""SELECT strftime(acq_date,'%Y-%m'),count(*) FROM
        (SELECT DISTINCT acq_date,cell_i,cell_j FROM days
         WHERE sensor IN ('Terra','Aqua') AND state_id!='OUT') GROUP BY 1""").fetchall()
    for month, total in union_totals:
        if month >= "2002-07":
            assert series["regions"]["MX"]["Union"][months.index(month)] == total, (month, total)
    return f"{len(totals)} meses-sensor contrastados con parquet"


def coverage():
    outside, total = con.execute("""SELECT sum(CASE WHEN s.state_id='OUT' THEN r.n_det ELSE 0 END),sum(r.n_det)
                                   FROM raw r JOIN state s USING(cell_i,cell_j)""").fetchone()
    fraction = 1 - outside / total
    assert fraction >= .97, fraction
    return f"fracción asignada={fraction:.6f}; OUT={outside / total:.6f}"


def harmonized():
    mx = harm["regions"]["MX"]
    months = harm["months"]
    raw = series["regions"]["MX"]
    for i, month in enumerate(months):
        if month >= "2012-02":
            assert mx["valor"][i] == raw["SNPP"][i], month
    i = months.index("2012-01")
    assert mx["fuente"][i] == "Aqua*k"
    assert math.isclose(mx["valor"][i], raw["Aqua"][i] * mx["k_aqua"][0], rel_tol=0, abs_tol=1e-9)
    assert mx["lo"][i] is not None and mx["hi"][i] is not None
    i = months.index("2012-02")
    assert mx["fuente"][i] == "SNPP" and mx["valor"][i] == raw["SNPP"][i]
    i = months.index("2005-06")
    assert mx["fuente"][i] == "Terra∪Aqua*k"
    for key in ("k_aqua", "k_terra"):
        assert all(k is not None and .2 <= k <= 25 for k in mx[key]), (key, mx[key])
    return "enero 2012 Aqua*k; SNPP exacto desde febrero 2012; 24 razones verificadas"


def independent_union():
    months = series["months"]
    regions = ("MX", "MX-CHP", "MX-JAL")
    sample_months = ("2002-07", "2005-05", "2018-04")
    for region in regions:
        for month in sample_months:
            state_filter = "" if region == "MX" else "AND s.state_id=?"
            params = [month] if region == "MX" else [month, region]
            count = con.execute(f"""SELECT count(DISTINCT (r.acq_date,r.cell_i,r.cell_j))
                FROM raw r JOIN state s USING(cell_i,cell_j)
                WHERE r.sensor IN ('Terra','Aqua') AND s.state_id!='OUT'
                  AND strftime(r.acq_date,'%Y-%m')=? {state_filter}""", params).fetchone()[0]
            assert series["regions"][region]["Union"][months.index(month)] == count, (region, month, count)
    ratios = []
    for year in range(2012, 2022):
        snpp, union = con.execute("""SELECT
            count(DISTINCT (CASE WHEN r.sensor='SNPP' THEN (r.acq_date,r.cell_i,r.cell_j) END)),
            count(DISTINCT (CASE WHEN r.sensor IN ('Terra','Aqua') THEN (r.acq_date,r.cell_i,r.cell_j) END))
            FROM raw r JOIN state s USING(cell_i,cell_j)
            WHERE s.state_id!='OUT' AND year(r.acq_date)=? AND month(r.acq_date)=5""", [year]).fetchone()
        if snpp > 0 and union > 0:
            ratios.append(snpp / union)
    k = float(np.median(ratios))
    i = months.index("2005-05")
    expected = series["regions"]["MX"]["Union"][i] * k
    assert math.isclose(harm["regions"]["MX"]["valor"][i], expected, abs_tol=1e-9)
    return f"9 conteos, k mayo={k:.9f}, valor mayo 2005={expected:.9f}"


def union_validation_and_sources():
    assert harm["metodo_union"] == {"desde": "2002-07", "hasta": "2011-12",
        "definicion": "celda-día 0.05° con detección de Terra o Aqua (día y noche)"}
    mx = harm["regions"]["MX"]["validation"]["union->snpp"]
    summary = harm["validation_resumen"]["union->snpp"]
    assert mx["n_meses"] == 119
    assert math.isclose(mx["mape_razon_mensual"] * 100, 5.525, abs_tol=1e-3)
    assert math.isclose(summary["mediana_mape_razon_mensual"] * 100, 19.525, abs_tol=1e-3)
    assert summary["n_regiones"] == 32
    for region, row in harm["regions"].items():
        for i, month in enumerate(harm["months"]):
            expected = ("Terra*k" if month < "2002-07" else
                        "Terra∪Aqua*k" if month <= "2011-12" else
                        "Aqua*k" if month == "2012-01" else "SNPP")
            assert row["fuente"][i] == expected, (region, month, row["fuente"][i])
            if month < "2002-07":
                assert series["regions"][region]["Union"][i] is None
            if expected != "SNPP":
                pair = ("terra->snpp" if expected == "Terra*k" else
                        "union->snpp" if expected == "Terra∪Aqua*k" else "aqua->snpp")
                error = row["validation"][pair]["mape_razon_mensual"]
                value = row["valor"][i]
                band = min(1.0, max(.05, error)) if error is not None else None
                assert row["lo"][i] == (value * (1 - band) if value is not None and band is not None else None)
                assert row["hi"][i] == (value * (1 + band) if value is not None and band is not None else None)
    return "M2 nacional 5.525 %, mediana estatal 19.525 %, n=119; fuentes por mes y región"


def independent_validation():
    frame = con.execute("""SELECT sensor,strftime(acq_date,'%Y-%m') AS month,count(*) AS n
                           FROM days WHERE state_id!='OUT' AND year(acq_date) BETWEEN 2012 AND 2021
                           GROUP BY 1,2""").df()
    wide = frame.pivot(index="month", columns="sensor", values="n").fillna(0)
    wide = wide.drop(index="2012-01", errors="ignore")
    monthly_errors, global_errors, predictions, truths = [], [], [], []
    for held in range(2012, 2022):
        training = wide.loc[~wide.index.str.startswith(str(held))].copy()
        training["calendar_month"] = training.index.str[-2:].astype(int)
        valid = training[(training.Aqua > 0) & (training.SNPP > 0)]
        by_month = (valid.SNPP / valid.Aqua).groupby(valid.calendar_month).median()
        global_k = valid.SNPP.sum() / valid.Aqua.sum()
        test = wide.loc[wide.index.str.startswith(str(held))]
        for month, row in test.iterrows():
            if row.SNPP < 5 or row.Aqua <= 0 or int(month[-2:]) not in by_month:
                continue
            pred = row.Aqua * by_month[int(month[-2:])]
            monthly_errors.append(abs(pred - row.SNPP) / row.SNPP)
            global_errors.append(abs(row.Aqua * global_k - row.SNPP) / row.SNPP)
            predictions.append(pred)
            truths.append(row.SNPP)
    expected = [float(np.median(monthly_errors)), float(np.median(global_errors)),
                sum(predictions) / sum(truths) - 1]
    actual = harm["regions"]["MX"]["validation"]["aqua->snpp"]
    for key, value in zip(("mape_razon_mensual", "mape_razon_global", "sesgo_razon_mensual"), expected):
        assert math.isclose(actual[key], value, abs_tol=1e-9), (key, actual[key], value)
    assert actual["n_meses"] == len(monthly_errors)
    return f"{len(monthly_errors)} meses; tres métricas coinciden ±1e-9"


def health_types():
    integer_keys = {"year", "n", "n_celdas_viirs", "terra_cell_days", "aqua_cell_days", "snpp_cell_days"}
    float_keys = {"lst_median", "terra_snpp", "aqua_snpp", "p_mismo_dia", "p_dia_siguiente", "p_dia_previo"}
    rows = 0
    for region in health.values():
        for table in region.values():
            for row in table:
                rows += 1
                for key, value in row.items():
                    if value is None:
                        continue
                    if key in integer_keys:
                        assert type(value) is int, (key, value)
                    elif key in float_keys:
                        assert type(value) is float and math.isfinite(value), (key, value)
                    else:
                        assert type(value) is str, (key, value)
    assert type(health["mx"]["lst_by_year"][0]["year"]) is int
    assert type(health["mx"]["versions_by_year"][0]["version"]) is str
    return f"{rows} filas; números tipados y versión conservada como texto"


def validation_summary():
    assert set(harm["validation_resumen"]) == {"aqua->snpp", "terra->snpp", "union->snpp"}
    for pair, actual in harm["validation_resumen"].items():
        rows = [region["validation"][pair] for key, region in harm["regions"].items()
                if key != "MX" and not region["validation"][pair]["insuficiente"]]
        monthly = np.array([row["mape_razon_mensual"] for row in rows])
        global_errors = np.array([row["mape_razon_global"] for row in rows])
        expected = {"mediana_mape_razon_mensual": np.median(monthly),
                    "mediana_mape_razon_global": np.median(global_errors),
                    "p25_mape_razon_mensual": np.percentile(monthly, 25),
                    "p75_mape_razon_mensual": np.percentile(monthly, 75),
                    "max_mape_razon_mensual": np.max(monthly)}
        assert actual["n_regiones"] == len(rows)
        for key, value in expected.items():
            assert math.isclose(actual[key], float(value), rel_tol=0, abs_tol=1e-9), (pair, key, actual[key], value)
    return "tres pares; resumen estatal recalculado ±1e-9"


def independent_baseline():
    data = con.execute("""SELECT acq_date,count(*) AS n FROM days WHERE sensor='SNPP' AND state_id!='OUT'
                          AND year(acq_date) BETWEEN 2012 AND 2025 GROUP BY 1""").fetchall()
    sample = [n for date, n in data if abs(date.timetuple().tm_yday - 150) <= 3]
    for key, q in (("p50", 50), ("p90", 90)):
        actual = baseline["regions"]["MX"][key][149]
        expected = float(np.percentile(sample, q))
        assert math.isclose(actual, expected, abs_tol=1e-9), (key, actual, expected)
    return f"día 150; {len(sample)} valores; p50/p90 coinciden ±1e-9"


def serie_2026():
    months = series["months"]
    assert months[0] == "2000-11" and months[-1] == "2026-10" and len(months) == 26 * 12
    assert cells["years"] == list(range(2000, 2027))
    assert con.execute("SELECT max(acq_date)::VARCHAR FROM raw").fetchone()[0] == "2026-10-31"
    nrt = {"Terra": ["2026-09", "2026-10"], "Aqua": ["2026-09", "2026-10"],
           "SNPP": ["2026-08", "2026-09", "2026-10"], "Union": ["2026-09", "2026-10"]}
    assert series["provisional"] == nrt and harm["provisional"] == nrt["SNPP"]
    for region, row in harm["regions"].items():
        for month in months[-10:]:
            i = months.index(month)
            assert row["fuente"][i] == "SNPP" and row["valor"][i] == series["regions"][region]["SNPP"][i]
            assert row["lo"][i] is None and row["hi"][i] is None and row["deriva"][i] is True
    days = dict(con.execute("""SELECT strftime(acq_date,'%Y-%m'),count(DISTINCT acq_date) FROM raw
                               WHERE sensor='SNPP' AND acq_date >= DATE '2012-02-01' GROUP BY 1""").fetchall())
    expected = {month: missing for month, n in sorted(days.items())
                if (missing := pd.Period(month).days_in_month - n)}
    actual = series["dias_sin_deteccion"]["SNPP"]
    assert actual == expected, (actual, expected)
    assert actual["2024-07"] == 11 and actual["2026-07"] == 6
    assert sum(n for month, n in actual.items() if month.startswith("2026")) == 15
    return f"312 meses hasta 2026-10; NRT {nrt['SNPP'][0]}→; {sum(actual.values())} días sin S-NPP en {len(actual)} meses"


def schema():
    n = len(series["months"])
    assert harm["months"] == series["months"]
    for region in series["regions"]:
        for sensor in series["sensors"]:
            assert len(series["regions"][region][sensor]) == n
        for key in ("valor", "fuente", "lo", "hi", "deriva"):
            assert len(harm["regions"][region][key]) == n
    nc = len(cells["lat"])
    assert len(cells["lon"]) == len(cells["state"]) == nc
    assert all(len(row) == len(cells["years"]) for sensor in cells["cell_days"].values() for row in sensor)
    assert all(len(sensor) == nc for sensor in cells["cell_days"].values())
    for path in (ROOT / "web/data").glob("*.json"):
        load(path.name)
    return f"{n} meses; {nc} celdas; JSON sin NaN/Infinity"


def sizes():
    return ", ".join(f"{p.name}={p.stat().st_size / 1024:.1f} KB" for p in sorted((ROOT / "web/data").glob("*.json")))


check("desempate de estado", majority_ties)
check("determinismo de exportación", export_determinism)
check("puntos conocidos", known_points)
check("partición mensual", partition)
check("cobertura estatal", coverage)
check("armonización MX", harmonized)
check("unión y valor independientes", independent_union)
check("validación M2 y fuentes", union_validation_and_sources)
check("validación MX Aqua independiente", independent_validation)
check("tipos de health", health_types)
check("resumen de validación estatal", validation_summary)
check("línea base MX independiente", independent_baseline)
check("serie hasta 2026, provisional y días sin S-NPP", serie_2026)
check("esquema y finitud", schema)
check("tamaños", sizes)
print(f"RESULTADO: {failures} fallo(s)")
sys.exit(1 if failures else 0)
