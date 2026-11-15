import calendar
import csv
import json
import math
from collections import defaultdict
from datetime import datetime, timezone

import duckdb
import numpy as np

from common import PROCESSED, ROOT


DEST = ROOT / "web/data"
SENSORS = ("Terra", "Aqua", "SNPP")
MONTHLY_SENSORS = (*SENSORS, "Union")
START = {"Terra": "2000-11", "Aqua": "2002-07", "SNPP": "2012-01", "Union": "2002-07"}
HEALTH_INTS = {"year", "n", "n_celdas_viirs", "terra_cell_days", "aqua_cell_days", "snpp_cell_days"}
HEALTH_FLOATS = {"lst_median", "terra_snpp", "aqua_snpp", "p_mismo_dia", "p_dia_siguiente", "p_dia_previo"}


def periods(last):
    """Meses y años del registro, de noviembre de 2000 al último mes con datos (AAAA-MM)."""
    end = (int(last[:4]), int(last[5:]))
    months = [f"{year}-{month:02d}" for year in range(2000, end[0] + 1) for month in range(1, 13)
              if (2000, 11) <= (year, month) <= end]
    return months, list(range(2000, end[0] + 1))


def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, np.generic):
        return clean(value.item())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def write(name, value):
    path = DEST / name
    path.write_text(json.dumps(clean(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False))
    print(f"{name}: {path.stat().st_size / 1024:.1f} KB")


def median(values):
    return float(np.median(values)) if values else None


def majority_state(states_count: dict[str, int]) -> str:
    # OUT participa en el desempate alfabético como cualquier otro state_id.
    return min(states_count, key=lambda state: (-states_count[state], state))


def factors(series, sensor, excluded=None):
    result = {}
    for month in range(1, 13):
        ratios = []
        for year in range(2012, 2022):
            if year == excluded:
                continue
            key = f"{year}-{month:02d}"
            if key == "2012-01":
                continue
            a, b = series["SNPP"].get(key, 0), series[sensor].get(key, 0)
            if a > 0 and b > 0:
                ratios.append(a / b)
        result[month] = median(ratios)
    return result


def validate(series, sensor):
    monthly_errors, global_errors, predicted, actual = [], [], 0.0, 0.0
    for excluded in range(2012, 2022):
        km = factors(series, sensor, excluded)
        train = [(series["SNPP"].get(f"{y}-{m:02d}", 0), series[sensor].get(f"{y}-{m:02d}", 0))
                 for y in range(2012, 2022) if y != excluded for m in range(1, 13) if (y, m) != (2012, 1)]
        train = [(a, b) for a, b in train if a > 0 and b > 0]
        kg = sum(a for a, _ in train) / sum(b for _, b in train) if train else None
        for month in range(1, 13):
            key = f"{excluded}-{month:02d}"
            if key == "2012-01":
                continue
            truth, raw = series["SNPP"].get(key, 0), series[sensor].get(key, 0)
            if truth < 5 or raw <= 0 or km[month] is None or kg is None:
                continue
            pred = raw * km[month]
            monthly_errors.append(abs(pred - truth) / truth)
            global_errors.append(abs(raw * kg - truth) / truth)
            predicted += pred
            actual += truth
    n = len(monthly_errors)
    return {"mape_razon_mensual": median(monthly_errors) if n >= 24 else None,
            "mape_razon_global": median(global_errors) if n >= 24 else None,
            "sesgo_razon_mensual": predicted / actual - 1 if n >= 24 else None,
            "n_meses": n, "insuficiente": n < 24}


def build():
    DEST.mkdir(exist_ok=True)
    geo = json.loads((DEST / "geo/mx_states.geojson").read_text())
    names = {f["properties"]["id"]: f["properties"]["name"] for f in geo["features"]}
    names = {"MX": "México", **names}
    regions = list(names)
    con = duckdb.connect()
    source = str(PROCESSED / "mx/cell_day.parquet")
    states = str(PROCESSED / "mx/cell_state.parquet")
    con.execute(f"CREATE VIEW raw AS SELECT * FROM read_parquet('{source}')")
    con.execute(f"CREATE VIEW state AS SELECT * FROM read_parquet('{states}')")
    con.execute("""CREATE TEMP VIEW distinct_days AS SELECT DISTINCT r.sensor,r.acq_date,r.cell_i,r.cell_j,s.state_id
                   FROM raw r JOIN state s USING(cell_i,cell_j)""")
    MONTHS, YEARS = periods(con.execute("SELECT strftime(max(acq_date),'%Y-%m') FROM raw").fetchone()[0])
    # Meses que vienen del producto casi en tiempo real (NRT) de FIRMS: provisionales.
    provisional = {sensor: [] for sensor in MONTHLY_SENSORS}
    nrt = PROCESSED / "mx/provisional_months.csv"
    if nrt.exists():
        with nrt.open(newline="") as file:
            for row in csv.DictReader(file):
                provisional[row["sensor"]].append(row["month"])
    provisional["Union"] = sorted(set(provisional["Terra"]) | set(provisional["Aqua"]))
    # Días del mes en que S-NPP, la escala de referencia, no dejó ninguna detección: no se rellenan.
    seen = dict(con.execute("""SELECT strftime(acq_date,'%Y-%m'),count(DISTINCT acq_date) FROM raw
                               WHERE sensor='SNPP' GROUP BY 1""").fetchall())
    no_detection = {month: missing for month in MONTHS if month > "2012-01" and
                    (missing := calendar.monthrange(int(month[:4]), int(month[5:]))[1] - seen.get(month, 0))}
    counts = dict(con.execute("SELECT sensor,count(*) FROM raw GROUP BY 1 ORDER BY 1").fetchall())
    write("meta.json", {"generado": datetime.now(timezone.utc).isoformat(), "filas_entrada_por_sensor": counts,
          "definiciones": {"celda_dia": "Una celda de 0.05° con detección en un día; se unen día y noche.",
          "tamano_celda": "Cada celda mide 0.05° de latitud por 0.05° de longitud.",
          "serie_armonizada": "Serie en escala VIIRS S-NPP; 2000-11 a 2002-06 usa Terra y 2002-07 a 2011-12 usa la unión Terra-Aqua con razones mensuales.",
          "ventana_pre_deriva": "Las razones se estiman con 2012–2021, antes de la deriva orbital posterior.",
          "enero_2012": "Enero de 2012 es un mes parcial de S-NPP (inicia el 20 de enero); se estima con Aqua.",
          "banda_error": "Rango ilustrativo basado en el error mediano de validación, acotado entre 5 % y 100 %; NO es un intervalo estadístico formal.",
          "provisional": "Meses que vienen del producto casi en tiempo real (NRT) de FIRMS; pueden cambiar cuando NASA publique la versión estándar.",
          "dias_sin_deteccion": "Días del mes sin ninguna detección de S-NPP en México (el sensor no entregó datos sobre México); el conteo del mes no se rellena."}})

    monthly = con.execute("""SELECT sensor,state_id,strftime(acq_date,'%Y-%m') AS month,count(*) AS n
                            FROM distinct_days WHERE state_id!='OUT' GROUP BY 1,2,3""").fetchall()
    monthly += con.execute("""SELECT 'Union',state_id,strftime(acq_date,'%Y-%m') AS month,count(*) AS n
                              FROM (SELECT DISTINCT acq_date,cell_i,cell_j,state_id FROM distinct_days
                                    WHERE state_id!='OUT' AND sensor IN ('Terra','Aqua'))
                              GROUP BY 2,3""").fetchall()
    by_region = {region: {sensor: {} for sensor in MONTHLY_SENSORS} for region in regions}
    for sensor, state, month, n in monthly:
        by_region[state][sensor][month] = n
        by_region["MX"][sensor][month] = by_region["MX"][sensor].get(month, 0) + n
    series = {region: {sensor: [None if m < START[sensor] else by_region[region][sensor].get(m, 0)
                                for m in MONTHS] for sensor in MONTHLY_SENSORS} for region in regions}
    write("series_monthly.json", {"unidad": "celdas-día con detección (celdas de 0.05°; unión día+noche)",
          "months": MONTHS, "sensors": list(MONTHLY_SENSORS), "region_names": names, "regions": series,
          "provisional": provisional, "dias_sin_deteccion": {"SNPP": no_detection}})

    yearly = con.execute("""SELECT d.sensor,year(d.acq_date) AS year,
                                 CAST(floor(d.cell_i / 5.0) AS INTEGER) AS ci,
                                 CAST(floor(d.cell_j / 5.0) AS INTEGER) AS cj,
                                 d.state_id,count(*) AS cell_days
                          FROM distinct_days d GROUP BY 1,2,3,4,5""").fetchall()
    majority = con.execute("""SELECT CAST(floor(r.cell_i / 5.0) AS INTEGER) AS ci,
                                   CAST(floor(r.cell_j / 5.0) AS INTEGER) AS cj,
                                   s.state_id,sum(r.n_det) AS detections
                            FROM raw r JOIN state s USING(cell_i,cell_j) GROUP BY 1,2,3""").fetchall()
    detected = defaultdict(lambda: defaultdict(int))
    yearly_counts = defaultdict(lambda: defaultdict(int))
    for ci, cj, state, n in majority:
        detected[(ci, cj)][state] = n
    for sensor, year, ci, cj, state, n in yearly:
        yearly_counts[(ci, cj)][sensor, year] += n
    kept = []
    excluded = 0
    for cell, states_count in sorted(detected.items()):
        state = majority_state(states_count)
        total = sum(yearly_counts[cell].values())
        if state == "OUT":
            excluded += 1
        else:
            kept.append((cell, state, total))

    def cells_json(items):
        return {"years": YEARS, "lat": [round((cell[0] + .5) * .25, 2) for cell, _, _ in items],
                "lon": [round((cell[1] + .5) * .25, 2) for cell, _, _ in items],
                "state": [state for _, state, _ in items],
                "cell_days": {sensor: [[None if f"{year}-12" < START[sensor] else
                                       yearly_counts[cell].get((sensor, year), 0) for year in YEARS]
                                      for cell, _, _ in items] for sensor in SENSORS}}

    cells = cells_json(kept)
    if len(json.dumps(cells, separators=(",", ":")).encode()) > 8_000_000:
        before = len(kept)
        kept = [item for item in kept if item[2] >= 3]
        print(f"Mapa reducido: {before - len(kept)} celdas con menos de 3 celdas-día")
        cells = cells_json(kept)
    write("cells_yearly.json", cells)
    print(f"Mapa: {len(kept)} celdas incluidas; {excluded} celdas excluidas por mayoría OUT")

    harmonized = {}
    insufficient = {sensor: 0 for sensor in ("Aqua", "Terra", "Union")}
    for region in regions:
        original = by_region[region]
        ks = {sensor: factors(original, sensor) for sensor in ("Aqua", "Terra", "Union")}
        validations = {sensor.lower() + "->snpp": validate(original, sensor) for sensor in ("Aqua", "Terra", "Union")}
        for sensor in ("Aqua", "Terra", "Union"):
            insufficient[sensor] += validations[sensor.lower() + "->snpp"]["insuficiente"]
        values, sources, low, high = [], [], [], []
        for month in MONTHS:
            number = int(month[-2:])
            if month >= START["SNPP"] and month != "2012-01":
                value, source_sensor = original["SNPP"].get(month, 0), "SNPP"
            else:
                sensor = "Union" if "2002-07" <= month <= "2011-12" else "Aqua" if month >= START["Aqua"] else "Terra"
                k = ks[sensor][number]
                value = original[sensor].get(month, 0) * k if k is not None else None
                source_sensor = "Terra∪Aqua*k" if sensor == "Union" else sensor + "*k"
            values.append(value)
            sources.append(source_sensor)
            if value is None or source_sensor == "SNPP":
                low.append(None); high.append(None)
            else:
                e = validations[sensor.lower() + "->snpp"]["mape_razon_mensual"]
                e = min(1.0, max(.05, e)) if e is not None else None
                low.append(value * (1 - e) if e is not None else None)
                high.append(value * (1 + e) if e is not None else None)
        harmonized[region] = {"valor": values, "fuente": sources, "lo": low, "hi": high,
                              "deriva": [int(month[:4]) >= 2022 for month in MONTHS],
                              "k_aqua": [ks["Aqua"][m] for m in range(1, 13)],
                              "k_terra": [ks["Terra"][m] for m in range(1, 13)],
                              "validation": validations}
    validation_resumen = {}
    for pair in ("aqua->snpp", "terra->snpp", "union->snpp"):
        valid = [harmonized[region]["validation"][pair] for region in regions if region != "MX"
                 and not harmonized[region]["validation"][pair]["insuficiente"]]
        monthly = [row["mape_razon_mensual"] for row in valid]
        global_errors = [row["mape_razon_global"] for row in valid]
        validation_resumen[pair] = {
            "mediana_mape_razon_mensual": median(monthly),
            "mediana_mape_razon_global": median(global_errors),
            "p25_mape_razon_mensual": float(np.percentile(monthly, 25)) if monthly else None,
            "p75_mape_razon_mensual": float(np.percentile(monthly, 75)) if monthly else None,
            "max_mape_razon_mensual": max(monthly) if monthly else None,
            "n_regiones": len(valid)}
    write("harmonized.json", {"months": MONTHS, "regions": harmonized, "validation_resumen": validation_resumen,
          "provisional": [month for month in provisional["SNPP"] if month > "2012-01"],
          "metodo_union": {"desde": "2002-07", "hasta": "2011-12",
                           "definicion": "celda-día 0.05° con detección de Terra o Aqua (día y noche)"}})
    print(f"Validación insuficiente: Aqua {insufficient['Aqua']}/33; Terra {insufficient['Terra']}/33; Union {insufficient['Union']}/33")

    daily = con.execute("""SELECT state_id,acq_date,count(*) AS n FROM distinct_days
                          WHERE sensor='SNPP' AND state_id!='OUT' AND year(acq_date) BETWEEN 2012 AND 2025
                          GROUP BY 1,2""").fetchall()
    daily_regions = defaultdict(list)
    for state, date, n in daily:
        doy = date.timetuple().tm_yday
        daily_regions[state].append((doy, n))
        daily_regions["MX"].append((doy, n))
    # MX requiere sumar los estados de cada fecha antes de calcular percentiles.
    mx_dates = con.execute("""SELECT acq_date,count(*) FROM distinct_days WHERE sensor='SNPP'
                            AND state_id!='OUT' AND year(acq_date) BETWEEN 2012 AND 2025 GROUP BY 1""").fetchall()
    daily_regions["MX"] = [(date.timetuple().tm_yday, n) for date, n in mx_dates]
    baseline = {}
    for region in regions:
        by_day = defaultdict(list)
        for doy, n in daily_regions[region]:
            for target in range(max(1, doy - 3), min(366, doy + 3) + 1):
                by_day[target].append(n)
        baseline[region] = {key: [] for key in ("p10", "p50", "p90", "p99", "max", "n_valores")}
        for day in range(1, 367):
            sample = by_day[day]
            for key, q in (("p10", 10), ("p50", 50), ("p90", 90), ("p99", 99)):
                baseline[region][key].append(float(np.percentile(sample, q)) if sample else None)
            baseline[region]["max"].append(max(sample) if sample else None)
            baseline[region]["n_valores"].append(len(sample))
    write("baseline_doy.json", {"regions": baseline})

    health = {}
    def health_value(key, value):
        if value is None or value.strip().lower() in ("", "nan", "inf", "+inf", "-inf", "infinity", "+infinity", "-infinity"):
            return None
        if key in HEALTH_INTS:
            return int(value)
        if key in HEALTH_FLOATS:
            number = float(value)
            return number if math.isfinite(number) else None
        return value

    for region in ("mx", "us"):
        health[region] = {}
        for stem in ("lst_by_year", "ratio_by_year", "versions_by_year", "overlap_probability"):
            with (PROCESSED / region / (stem + ".csv")).open(newline="") as file:
                health[region][stem] = [{k: health_value(k, v)
                                         for k, v in row.items()} for row in csv.DictReader(file)]
    write("health.json", health)
    con.close()


if __name__ == "__main__":
    build()
