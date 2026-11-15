import json

import duckdb
import numpy as np

from common import PROCESSED, ROOT


def in_ring(lat, lon, ring):
    vertices = np.asarray(ring, dtype=float)
    xs, ys = vertices[:, 0], vertices[:, 1]
    inside = np.zeros(len(lat), dtype=bool)
    for i in range(len(xs) - 1):
        x1, x2, y1, y2 = xs[i], xs[i + 1], ys[i], ys[i + 1]
        if y1 == y2:
            continue
        crossing = ((y1 > lat) != (y2 > lat)) & (lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1)
        inside ^= crossing
    return inside


def assign(lat, lon, features):
    result = np.full(len(lat), "OUT", dtype="U8")
    for feature in features:
        geometry = feature["geometry"]
        polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        for polygon in polygons:
            outer = np.asarray(polygon[0], dtype=float)
            candidate = np.flatnonzero((result == "OUT") & (lon >= outer[:, 0].min()) &
                                       (lon <= outer[:, 0].max()) & (lat >= outer[:, 1].min()) &
                                       (lat <= outer[:, 1].max()))
            if not len(candidate):
                continue
            contained = np.zeros(len(candidate), dtype=bool)
            for ring in polygon:
                contained ^= in_ring(lat[candidate], lon[candidate], ring)
            result[candidate[contained]] = feature["properties"]["id"]
    return result


def build():
    source = PROCESSED / "mx" / "cell_day.parquet"
    target = PROCESSED / "mx" / "cell_state.parquet"
    con = duckdb.connect()
    cells = con.execute("SELECT cell_i, cell_j, sum(n_det) AS n_det FROM read_parquet(?) GROUP BY 1,2 ORDER BY 1,2",
                        [str(source)]).df()
    features = json.loads((ROOT / "web/data/geo/mx_states.geojson").read_text())["features"]
    cells["state_id"] = assign((cells.cell_i.to_numpy() + .5) * .05,
                               (cells.cell_j.to_numpy() + .5) * .05, features)
    con.register("assigned", cells[["cell_i", "cell_j", "state_id"]])
    con.execute("COPY assigned TO ? (FORMAT PARQUET)", [str(target)])
    out = cells.loc[cells.state_id == "OUT", "n_det"].sum() / cells.n_det.sum()
    print(f"Celdas únicas: {len(cells)}; fracción de detecciones OUT: {out:.6f}")
    con.close()


if __name__ == "__main__":
    build()
