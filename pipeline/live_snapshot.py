"""Build the near-real-time Mexico VIIRS snapshot from the downloaded CSV files."""

import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from assign_regions import assign
from smoke import read_smoke, smoke_summary


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/live/raw"
DEST = ROOT / "web/data/live_snapshot.json"
SOURCES = ("VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT")
CELL_SIZE = 0.05
BASE_KEYS = ("p10", "p50", "p90", "p99", "max")
GOES_HOURS = 3
GOES_CELL = 0.02  # ~2 km, el tamaño del píxel de GOES ABI en el punto subsatelital
GOES_SATS = ("G18", "G18FRP", "G19", "G19FRP")


def classify(value, baseline):
    if baseline is None or any(baseline.get(key) is None for key in ("p10", "p90", "p99", "max")):
        return None
    if value > baseline["max"]:
        return "record"
    if value > baseline["p99"]:
        return "extraordinario"
    if value > baseline["p90"]:
        return "alto"
    if value >= baseline["p10"]:
        return "normal"
    return "bajo"


def hhmm(value):
    text = str(value).zfill(4)
    return text[:2] + ":" + text[2:]


def finite(value):
    value = float(value) if pd.notna(value) else None
    return value if value is not None and math.isfinite(value) else None


def read_extra(fetch, source, historical, features):
    """CSV de una fuente extra con instante y estado, o None si no se descargó en esta captura.

    Solo se usa si fetch_info.json dice que se descargó bien en esta misma captura: si la
    descarga falló, el CSV que quedó en disco es de otra captura y no se mezcla.
    """
    status = fetch.get("fuentes_extra", {}).get(source)
    if not status or not status.get("ok"):
        return None
    frame = pd.read_csv(RAW / f"{source}.csv", dtype={"acq_time": str, "confidence": str})
    frame["acquired"] = pd.to_datetime(frame["acq_date"] + frame["acq_time"].str.zfill(4),
                                       format="%Y-%m-%d%H%M", utc=True)
    frame["cell_i"] = np.floor(frame["latitude"].to_numpy() / CELL_SIZE).astype(int)
    frame["cell_j"] = np.floor(frame["longitude"].to_numpy() / CELL_SIZE).astype(int)
    cells = frame[["cell_i", "cell_j"]].drop_duplicates().merge(historical, on=["cell_i", "cell_j"], how="left")
    unseen = cells["state_id"].isna()
    if unseen.any():
        cells.loc[unseen, "state_id"] = assign((cells.loc[unseen, "cell_i"].to_numpy() + .5) * CELL_SIZE,
                                               (cells.loc[unseen, "cell_j"].to_numpy() + .5) * CELL_SIZE,
                                               features)
    return frame.merge(cells, on=["cell_i", "cell_j"], how="left", validate="many_to_one")


def modis_summary(frame, states, lower, upper):
    """MODIS NRT (Terra y Aqua) en México dentro de la misma ventana de 24 h que VIIRS."""
    if frame is None:
        return None
    kept = frame[frame["state_id"].isin(states) & (frame["acquired"] > lower) & (frame["acquired"] <= upper)]
    rows = [{"lat": round(float(r.latitude), 5), "lon": round(float(r.longitude), 5),
             "fecha": r.acq_date, "hora_utc": hhmm(r.acq_time), "sat": r.satellite,
             "frp": finite(r.frp), "conf": int(r.confidence), "estado": r.state_id}
            for r in kept.itertuples(index=False)]
    rows.sort(key=lambda row: (row["fecha"], row["hora_utc"], row["lat"], row["lon"], row["sat"]))
    latest = kept["acquired"].max()
    return {"fuente": "MODIS_NRT", "ventana_horas": 24, "n_24h": len(rows),
            "terra": sum(row["sat"] == "Terra" for row in rows),
            "aqua": sum(row["sat"] == "Aqua" for row in rows),
            "ultima_utc": latest.strftime("%Y-%m-%dT%H:%M:%SZ") if pd.notna(latest) else None,
            "detecciones": rows}


def goes_summary(frame, states, upper):
    """GOES NRT en México en las 3 h previas a la captura, para ver lo más nuevo, no para contar.

    FIRMS entrega cada imagen de GOES con dos algoritmos (G19 = NOAA FDC, G19FRP = KCL/IPMA
    FRP-PIXEL; igual G18), y GOES-18 y GOES-19 ven México a la vez: la misma fuente de calor
    aparece varias veces. Para el mapa se junta todo en celdas de 0.02° y cada celda conserva
    las coordenadas y la hora de su detección más reciente.
    """
    if frame is None:
        return None
    lower = upper - pd.Timedelta(hours=GOES_HOURS)
    kept = frame[frame["state_id"].isin(states) & (frame["acquired"] > lower) & (frame["acquired"] <= upper)].copy()
    kept["gi"] = np.floor(kept["latitude"].to_numpy() / GOES_CELL).astype(int)
    kept["gj"] = np.floor(kept["longitude"].to_numpy() / GOES_CELL).astype(int)
    kept = kept.sort_values(["acquired", "satellite", "latitude", "longitude"])
    points = []
    for _, group in kept.groupby(["gi", "gj"], sort=True):
        last = group.iloc[-1]
        points.append({"lat": round(float(last.latitude), 5), "lon": round(float(last.longitude), 5),
                       "fecha": last.acq_date, "hora_utc": hhmm(last.acq_time), "n": len(group),
                       "sats": sorted(group["satellite"].unique().tolist())})
    points.sort(key=lambda row: (row["fecha"], row["hora_utc"], row["lat"], row["lon"]))
    latest = kept["acquired"].max()
    return {"fuente": "GOES_NRT", "ventana_horas": GOES_HOURS, "celda_grados": GOES_CELL,
            "filas_ventana": len(kept),
            "por_satelite": {sat: int((kept["satellite"] == sat).sum()) for sat in GOES_SATS},
            "ultima_utc": latest.strftime("%Y-%m-%dT%H:%M:%SZ") if pd.notna(latest) else None,
            "puntos": points}


def build():
    fetch = json.loads((RAW / "fetch_info.json").read_text())
    downloaded = datetime.fromisoformat(fetch["descargado_utc"].replace("Z", "+00:00"))
    if downloaded.tzinfo is None:
        raise ValueError("descargado_utc debe incluir zona horaria")
    downloaded = downloaded.astimezone(timezone.utc)
    compared = downloaded.date() - timedelta(days=1)
    doy = compared.timetuple().tm_yday

    frames = [pd.read_csv(RAW / f"{source}.csv", dtype={"acq_time": str, "confidence": str})
              for source in SOURCES]
    detections = pd.concat(frames, ignore_index=True)
    detections["acquired"] = pd.to_datetime(
        detections["acq_date"] + detections["acq_time"].str.zfill(4),
        format="%Y-%m-%d%H%M", utc=True)
    detections["cell_i"] = np.floor(detections["latitude"].to_numpy() / CELL_SIZE).astype(int)
    detections["cell_j"] = np.floor(detections["longitude"].to_numpy() / CELL_SIZE).astype(int)

    con = duckdb.connect()
    historical = con.execute("SELECT cell_i, cell_j, state_id FROM read_parquet(?)",
                             [str(ROOT / "data/processed/mx/cell_state.parquet")]).df()
    con.close()
    cells = detections[["cell_i", "cell_j"]].drop_duplicates().merge(
        historical, on=["cell_i", "cell_j"], how="left")
    unseen = cells["state_id"].isna()
    if unseen.any():
        features = json.loads((ROOT / "web/data/geo/mx_states.geojson").read_text())["features"]
        cells.loc[unseen, "state_id"] = assign(
            (cells.loc[unseen, "cell_i"].to_numpy() + .5) * CELL_SIZE,
            (cells.loc[unseen, "cell_j"].to_numpy() + .5) * CELL_SIZE,
            features)
    detections = detections.merge(cells, on=["cell_i", "cell_j"], how="left", validate="many_to_one")

    states = sorted(feature["properties"]["id"] for feature in
                    json.loads((ROOT / "web/data/geo/mx_states.geojson").read_text())["features"])
    if len(states) != 32 or len(set(states)) != 32:
        raise ValueError("GeoJSON debe contener 32 estados únicos")
    out_count = int((detections["state_id"] == "OUT").sum())
    kept = detections[detections["state_id"].isin(states)]
    lower = pd.Timestamp(downloaded - timedelta(hours=24))
    upper = pd.Timestamp(downloaded)
    recent = kept[(kept["acquired"] > lower) & (kept["acquired"] <= upper)]

    day = kept[kept["acq_date"] == compared.isoformat()]
    sensors_used = int(sum((detections["satellite"].eq(sensor) &
                            detections["acq_date"].eq(compared.isoformat())).any()
                           for sensor in ("N20", "N21")))
    distinct = day[["state_id", "satellite", "cell_i", "cell_j"]].drop_duplicates()
    counts = distinct.groupby(["state_id", "satellite"]).size().to_dict()
    baseline = json.loads((ROOT / "web/data/baseline_doy.json").read_text())["regions"]

    def region_summary(region, n20, n21):
        cells_day = (n20 + n21) / sensors_used if sensors_used else None
        values = {f"base_{key}": baseline.get(region, {}).get(key, [None] * 366)[doy - 1]
                  for key in BASE_KEYS}
        thresholds = {key: values[f"base_{key}"] for key in BASE_KEYS}
        return {"n20": n20, "n21": n21, "celdas_dia": cells_day,
                "sensores_usados": sensors_used, **values,
                "nivel": classify(cells_day, thresholds) if cells_day is not None else None}

    state_results = {
        state: region_summary(state, int(counts.get((state, "N20"), 0)),
                              int(counts.get((state, "N21"), 0)))
        for state in states
    }
    national = region_summary("MX", sum(item["n20"] for item in state_results.values()),
                              sum(item["n21"] for item in state_results.values()))

    recent_rows = []
    for row in recent.itertuples(index=False):
        frp = float(row.frp) if pd.notna(row.frp) else None
        if frp is not None and not math.isfinite(frp):
            frp = None
        recent_rows.append({"lat": round(float(row.latitude), 5),
                            "lon": round(float(row.longitude), 5),
                            "fecha": row.acq_date,
                            "hora_utc": str(row.acq_time).zfill(4)[:2] + ":" + str(row.acq_time).zfill(4)[2:],
                            "sat": row.satellite, "frp": frp,
                            "conf": row.confidence, "estado": row.state_id})
    recent_rows.sort(key=lambda row: (row["fecha"], row["hora_utc"], row["lat"], row["lon"], row["sat"]))

    latest = detections["acquired"].max()
    features = json.loads((ROOT / "web/data/geo/mx_states.geojson").read_text())["features"]
    modis = modis_summary(read_extra(fetch, "MODIS_NRT", historical, features), states, lower, upper)
    goes = goes_summary(read_extra(fetch, "GOES_NRT", historical, features), states, upper)
    smoke = smoke_summary(*read_smoke(fetch, RAW), features, downloaded - timedelta(hours=24), downloaded)
    extra_errors = {source: status.get("error", "sin estado")
                    for source, status in fetch.get("fuentes_extra", {"MODIS_NRT": {}, "GOES_NRT": {}}).items()
                    if not status.get("ok")}
    snapshot = {
        "generado": fetch["descargado_utc"],
        "ultima_deteccion_utc": latest.strftime("%Y-%m-%dT%H:%M:%SZ") if pd.notna(latest) else None,
        "ventana_horas": 24,
        "dia_comparado": compared.isoformat(),
        "doy": doy,
        "fuentes": list(SOURCES),
        "nota": "Datos casi en tiempo real (NRT), sin calidad científica; comparados contra S-NPP 2012-2025.",
        "descartadas_fuera_de_mexico": out_count,
        "n_detecciones_24h": len(recent_rows),
        "nacional": national,
        "estados": state_results,
        "detecciones": recent_rows,
        "modis": modis,
        "goes": goes,
        "humo": smoke,
        "fuentes_extra_error": extra_errors,
    }
    DEST.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
    print(f"{DEST.relative_to(ROOT)}: {DEST.stat().st_size} bytes; "
          f"{len(recent_rows)} detecciones 24 h; {out_count} OUT; "
          f"MODIS 24 h={modis and modis['n_24h']}; GOES 3 h filas={goes and goes['filas_ventana']}, "
          f"puntos={goes and len(goes['puntos'])}, última={goes and goes['ultima_utc']}; "
          f"humo HMS={smoke and smoke['n']} de {smoke and smoke['poligonos_en_ventana']} en ventana; "
          f"errores={extra_errors}")
    return snapshot


if __name__ == "__main__":
    build()
